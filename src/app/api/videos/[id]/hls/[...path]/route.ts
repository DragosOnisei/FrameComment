import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { downloadFile, isS3Mode, getFilePath } from '@/lib/storage'
import { verifyVideoAccessToken } from '@/lib/video-access'
import { getRedis } from '@/lib/redis'
import { logError } from '@/lib/logging'
import fs from 'fs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 3.8.x PERF: short-TTL in-memory cache for the HLS video row. hls.js
// fires a separate request per segment (dozens while filling the buffer
// at startup — the "stuck at 00:00 for ~10s" symptom), and each used to
// do its own `video.findUnique`. Caching collapses those into one DB hit
// per TTL. Kept short (5s) so a tier finishing encoding mid-watch still
// shows up on the master-manifest poll within a few seconds.
const hlsVideoCache = new Map<string, { value: any; expiresAt: number }>()
const HLS_VIDEO_CACHE_TTL_MS = 5_000

async function getHlsVideoCached(videoId: string): Promise<any> {
  const now = Date.now()
  const hit = hlsVideoCache.get(videoId)
  if (hit && hit.expiresAt > now) return hit.value
  const video = (await prisma.video.findUnique({
    where: { id: videoId },
    select: {
      id: true,
      projectId: true,
      hlsBasePath: true,
      hlsQualities: true,
    } as any,
  })) as any
  if (video) {
    hlsVideoCache.set(videoId, {
      value: video,
      expiresAt: now + HLS_VIDEO_CACHE_TTL_MS,
    })
    if (hlsVideoCache.size > 500) {
      for (const [k, v] of hlsVideoCache) {
        if (v.expiresAt <= now) hlsVideoCache.delete(k)
      }
    }
  }
  return video
}

/**
 * 1.9.4+ Phase B: HLS streaming endpoints.
 *
 * One catch-all route serves three logical resources:
 *
 *   GET /api/videos/[id]/hls/master.m3u8
 *       → dynamic master manifest, listing ONLY the qualities
 *         currently present in `Video.hlsQualities`. Player
 *         polls this; when a higher tier finishes, the next
 *         poll picks it up and hls.js / Safari auto-upgrade
 *         without restarting playback.
 *
 *   GET /api/videos/[id]/hls/[tier]/playlist.m3u8
 *       → per-variant playlist that the worker remuxed via
 *         FFmpeg's `-c copy` HLS muxer. Served straight from
 *         storage with the right Content-Type.
 *
 *   GET /api/videos/[id]/hls/[tier]/seg_NNN.ts
 *       → individual segment bytes.
 *
 * Auth: a single token (?token=xxx) covers the whole HLS session.
 * hls.js automatically forwards query strings from the master
 * manifest URL to all child requests, so the player only needs
 * one token-bearing URL.
 *
 * The token reuses the existing video-access system — issue with
 * `generateVideoAccessToken(videoId, projectId, 'hls', ...)` and
 * verify here on every request.
 */

/**
 * 1.9.4+ Phase B: append `?token=…` to every segment line in
 * a variant playlist. Without this, hls.js requests segments via
 * relative URL resolution which discards the parent's query
 * string per RFC 3986 — segments end up unauthenticated and the
 * API returns 401, killing playback right at the first variant
 * switch. We only touch lines that look like segment refs (not
 * comments, not absolute URLs, not blank).
 */
function rewritePlaylistTokens(playlistText: string, tokenQuery: string): string {
  return playlistText
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed) return line
      if (trimmed.startsWith('#')) return line // tag / comment
      if (/^https?:\/\//i.test(trimmed)) return line // absolute URL — caller already includes query
      // Bare segment / playlist filename. Append the token query
      // string, mindful that the URI could already carry its own
      // query (unlikely for ffmpeg output, defensive anyway).
      const sep = trimmed.includes('?') ? '&' : ''
      return trimmed + (sep ? `${sep}${tokenQuery.slice(1)}` : tokenQuery)
    })
    .join('\n')
}

const TIER_BITRATE_K: Record<string, number> = {
  '480p': 1200,
  '720p': 3000,
  '1080p': 6000,
  '2160p': 16000,
}

const TIER_DIMENSIONS: Record<string, { w: number; h: number }> = {
  '480p': { w: 854, h: 480 },
  '720p': { w: 1280, h: 720 },
  '1080p': { w: 1920, h: 1080 },
  '2160p': { w: 3840, h: 2160 },
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> },
) {
  const { id: videoId, path: pathSegments } = await params

  // Token via query string (hls.js forwards it from master to
  // playlist to segments) or Authorization: Bearer header.
  const url = new URL(request.url)
  const token =
    url.searchParams.get('token') ||
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
    ''

  if (!token) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  // Lookup the token's session binding (same pattern the
  // /api/content/[token] endpoint uses): extract sessionId from
  // the stored token data, then pass it back to the verifier so
  // the session-mismatch check trivially passes for a legitimate
  // token. Admin-flagged tokens skip session binding entirely.
  let sessionId = ''
  try {
    const redis = getRedis()
    const raw = await redis.get(`video_access:${token}`)
    if (!raw) {
      return new NextResponse('Unauthorized', { status: 401 })
    }
    const parsed = JSON.parse(raw)
    sessionId = parsed.sessionId || ''
  } catch (err) {
    logError('[HLS] Token data lookup failed:', err)
    return new NextResponse('Unauthorized', { status: 401 })
  }

  let payload: Awaited<ReturnType<typeof verifyVideoAccessToken>>
  try {
    payload = await verifyVideoAccessToken(token, request, sessionId)
  } catch (err) {
    logError('[HLS] Token verification failed:', err)
    return new NextResponse('Unauthorized', { status: 401 })
  }

  if (!payload || payload.videoId !== videoId) {
    return new NextResponse('Forbidden', { status: 403 })
  }

  // Lookup video — we need hlsBasePath + hlsQualities for routing.
  // 3.8.x PERF: served from a 5s in-memory cache (see getHlsVideoCached)
  // so a burst of segment requests doesn't fan out into a DB query each.
  const video = await getHlsVideoCached(videoId)

  if (!video) {
    return new NextResponse('Video not found', { status: 404 })
  }

  if (!video.hlsBasePath || !video.hlsQualities || video.hlsQualities.length === 0) {
    return new NextResponse('HLS not yet available for this video', {
      status: 425, // Too Early — playback should retry shortly
    })
  }

  // ──────────────────────────────────────────────────────────
  // Routing on the catch-all path.
  // ──────────────────────────────────────────────────────────

  // Case 1: master.m3u8 — generated on the fly so adding a tier
  // mid-job shows up on the next poll.
  if (pathSegments.length === 1 && pathSegments[0] === 'master.m3u8') {
    const lines: string[] = ['#EXTM3U', '#EXT-X-VERSION:3']
    // Preserve the token so child requests inherit it. hls.js
    // also does this automatically, but explicit query strings
    // on the URL lines make the manifest work with curl / VLC.
    const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : ''
    // Order tiers from lowest → highest so the player can pick
    // its starting variant from the first acceptable bandwidth.
    const tierOrder: Array<'480p' | '720p' | '1080p' | '2160p'> = ['480p', '720p', '1080p', '2160p']
    for (const tier of tierOrder) {
      if (!video.hlsQualities.includes(tier)) continue
      const bitrate = (TIER_BITRATE_K[tier] || 3000) * 1000
      const dims = TIER_DIMENSIONS[tier]
      const resolution = dims ? `${dims.w}x${dims.h}` : ''
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${bitrate}${resolution ? `,RESOLUTION=${resolution}` : ''},NAME="${tier}"`,
      )
      lines.push(`${tier}/playlist.m3u8${tokenQuery}`)
    }
    return new NextResponse(lines.join('\n') + '\n', {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        // 1.9.4+ Phase B: never cache the master. It's tiny
        // (a few hundred bytes) and we MUST pick up new variants
        // the moment the worker finishes the next tier. With
        // any caching at all, browser / hls.js might serve a
        // stale master and miss the upgrade trigger.
        'Cache-Control': 'no-store',
      },
    })
  }

  // Case 2 + 3: serve a playlist or segment file from storage.
  // The storage path is <hlsBasePath>/<tier>/<file>.
  if (pathSegments.length === 2) {
    const [tier, file] = pathSegments
    // Validate the tier is real (defence against path traversal
    // disguised as a tier name).
    if (!/^(480p|720p|1080p|2160p)$/.test(tier)) {
      return new NextResponse('Invalid tier', { status: 400 })
    }
    // Whitelisted filenames: playlist.m3u8 or seg_NNN.ts.
    if (!/^(playlist\.m3u8|seg_\d+\.ts)$/.test(file)) {
      return new NextResponse('Invalid file', { status: 400 })
    }
    if (!video.hlsQualities.includes(tier)) {
      return new NextResponse('Tier not yet available', { status: 425 })
    }

    const storagePath = `${video.hlsBasePath}/${tier}/${file}`
    const contentType = file.endsWith('.m3u8')
      ? 'application/vnd.apple.mpegurl'
      : 'video/mp2t'

    // 1.9.4+ Phase B: for variant playlists (.m3u8) we rewrite
    // the bare segment names (`seg_000.ts`) to include the same
    // `?token=…` query string. RFC 3986 relative URL resolution
    // does NOT preserve query strings from the base, so without
    // this hack hls.js would request `seg_000.ts` (no token) and
    // get a 401 — playback stalls at the first variant switch.
    // For .ts segments we just stream the bytes through.
    const tokenQuery = `?token=${encodeURIComponent(token)}`

    try {
      if (isS3Mode()) {
        if (file.endsWith('.m3u8')) {
          // S3 small files — read fully so we can rewrite.
          const stream = await downloadFile(storagePath)
          const chunks: Buffer[] = []
          await new Promise<void>((res, rej) => {
            stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
            stream.on('end', () => res())
            stream.on('error', rej)
          })
          const text = Buffer.concat(chunks).toString('utf8')
          const rewritten = rewritePlaylistTokens(text, tokenQuery)
          return new NextResponse(rewritten, {
            status: 200,
            headers: {
              'Content-Type': contentType,
              'Cache-Control': 'public, max-age=5, must-revalidate',
            },
          })
        }
        // Segments: stream as-is.
        const stream = await downloadFile(storagePath)
        const webStream = new ReadableStream({
          start(controller) {
            stream.on('data', (chunk) => controller.enqueue(chunk))
            stream.on('end', () => controller.close())
            stream.on('error', (err) => controller.error(err))
          },
        })
        return new NextResponse(webStream, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        })
      }
      // Local mode: read file from disk and return.
      const localPath = getFilePath(storagePath)
      if (!fs.existsSync(localPath)) {
        return new NextResponse('File not found', { status: 404 })
      }
      if (file.endsWith('.m3u8')) {
        const text = await fs.promises.readFile(localPath, 'utf8')
        const rewritten = rewritePlaylistTokens(text, tokenQuery)
        return new NextResponse(rewritten, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=5, must-revalidate',
          },
        })
      }
      const buffer = await fs.promises.readFile(localPath)
      return new NextResponse(buffer, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      })
    } catch (err) {
      logError(`[HLS] Failed to serve ${storagePath}:`, err)
      return new NextResponse('File not available', { status: 404 })
    }
  }

  return new NextResponse('Not found', { status: 404 })
}
