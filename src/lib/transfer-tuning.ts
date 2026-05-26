const MB = 1024 * 1024

type RangeTuple = { start: number; end: number }

function parseEnvMb(name: string, fallbackMb: number, minMb: number, maxMb: number): number {
  const raw = process.env[name]
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    return fallbackMb * MB
  }
  const bounded = Math.min(Math.max(parsed, minMb), maxMb)
  return Math.floor(bounded) * MB
}

export const STREAM_HIGH_WATER_MARK_BYTES = parseEnvMb('TRANSFER_STREAM_HWM_MB', 4, 1, 32)
export const STREAM_CHUNK_SIZE_BYTES = parseEnvMb('TRANSFER_STREAM_CHUNK_MB', 4, 1, 64)
export const DOWNLOAD_CHUNK_SIZE_BYTES = parseEnvMb('TRANSFER_DOWNLOAD_CHUNK_MB', 16, 4, 128)
export const TUS_RETRY_DELAYS_MS = [0, 1000, 3000, 5000, 10000]

function getEffectiveNetworkType(): string | undefined {
  if (typeof navigator === 'undefined') return undefined
  const nav = navigator as Navigator & {
    connection?: { effectiveType?: string }
  }
  return nav.connection?.effectiveType
}

function isMobileUserAgent(): boolean {
  if (typeof navigator === 'undefined') return false
  // Covers iPhone/iPad/Android phones and tablets. Catches the
  // mobile-Safari, Chrome-Android, and Brave-mobile browsers we
  // care about. Conservative on purpose — if we mis-detect a
  // desktop as mobile the only consequence is slightly more
  // PATCH requests, which is fine.
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
}

export function getTusChunkSizeBytes(fileSize: number): number {
  const effectiveType = getEffectiveNetworkType()
  const onMobile = isMobileUserAgent()

  // On slow connections keep chunks small so a stalled part doesn't block for too long
  if (effectiveType === 'slow-2g' || effectiveType === '2g') return 2 * MB
  if (effectiveType === '3g') return onMobile ? 2 * MB : 8 * MB

  // 1.3.1+: mobile browsers (especially iOS Safari and Chrome-Android)
  // drop the XHR connection between TUS PATCH requests — the upload
  // stalls right after the first chunk and never recovers because the
  // client never sends PATCH #2. We work around this by uploading the
  // whole file in a SINGLE PATCH on mobile (chunkSize >= fileSize).
  // This guarantees there's only ever one PATCH, so the "between
  // chunks" failure mode can't happen.
  //
  // For files bigger than 100 MiB we fall back to 8 MiB chunks because
  // a 100+ MiB single PATCH risks memory pressure / proxy timeouts.
  // 100 MiB is also under Cloudflare's 100 MiB body limit which we'd
  // want to stay under for production deploys behind their proxy.
  if (onMobile) {
    if (fileSize >= 100 * MB) return 8 * MB
    // Ensure a single PATCH carries the entire file by setting the
    // chunk size to the file size itself. tus-js-client will then
    // send one PATCH with `Content-Length: <fileSize>` and finish.
    return Math.max(fileSize, MB)
  }

  // Desktop chunk-size history:
  //   1.5.0  — 25 MiB. Worked, but a 3 GB upload meant ~123 sequential
  //            PATCH requests and per-chunk overhead (lock acquire,
  //            `.json` read, fs.stat, WriteStream teardown) dominated on
  //            HDD-backed self-hosted deploys, dragging throughput down
  //            to ~0.5 MB/s after the first few chunks.
  //   1.5.5  — 256 MiB. Cut PATCH count to ~12 but a single chunk now
  //            exceeded Cloudflare's 100 MB body limit (free plan) so
  //            every PATCH returned 413 Payload Too Large for users
  //            proxying through CF.
  //   1.5.6+ — 96 MiB. The compromise: stays safely under CF's 100 MB
  //            ceiling, still cuts a 3 GB upload to ~32 PATCH requests
  //            (4x fewer than 1.5.0) so per-chunk overhead is mostly
  //            amortized away. Pair with `zfs set sync=disabled` on
  //            the uploads dataset for HDD deploys to drop fsync stalls.
  //
  // 96 MiB is also under nginx's default `client_max_body_size` of 100M
  // on most distros and under typical k3s ingress defaults.
  //
  // The desktop fallback for smaller files stays at 10 MiB — same
  // reasoning, the per-chunk overhead just doesn't matter there.
  if (fileSize >= 100 * MB) return 96 * MB
  return 10 * MB
}

export function parseBoundedRangeHeader(
  rangeHeader: string,
  totalSize: number,
  maxChunkSize: number
): RangeTuple | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim())
  if (!match) return null

  const rawStart = match[1]
  const rawEnd = match[2]

  if (!rawStart && !rawEnd) return null

  let start: number
  let end: number

  if (rawStart) {
    start = Number.parseInt(rawStart, 10)
    if (!Number.isFinite(start) || start < 0 || start >= totalSize) return null

    const requestedEnd = rawEnd ? Number.parseInt(rawEnd, 10) : start + maxChunkSize - 1
    if (!Number.isFinite(requestedEnd) || requestedEnd < start) return null

    end = Math.min(requestedEnd, start + maxChunkSize - 1, totalSize - 1)
  } else {
    const suffixLength = Number.parseInt(rawEnd, 10)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null

    const boundedSuffix = Math.min(suffixLength, maxChunkSize, totalSize)
    start = Math.max(totalSize - boundedSuffix, 0)
    end = totalSize - 1
  }

  if (end < start) return null
  return { start, end }
}