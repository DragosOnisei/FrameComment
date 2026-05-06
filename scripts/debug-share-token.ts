/**
 * Simulates exactly what the public share page does when it tries to load
 * the video, by hitting the same endpoints with the share token. Surfaces
 * the precise reason the player gets stuck on "Loading video..." (token
 * generation failure, content endpoint 404, missing share token, etc).
 *
 *   npx tsx scripts/debug-share-token.ts <slug>
 *
 * If you don't pass a slug it defaults to "test".
 */
import 'dotenv/config'
import { config as dotenvConfig } from 'dotenv'
import path from 'node:path'

dotenvConfig({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'
import IORedis from 'ioredis'

const prisma = new PrismaClient()
const redis = new IORedis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
})
redis.on('error', (e) => {
  // Suppress noisy reconnects — the script handles failure inline.
  if (!String(e?.message || e).includes('connect')) {
    process.stderr.write(`[ioredis] ${e?.message || e}\n`)
  }
})
const BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000'

async function main() {
  const slug = process.argv[2] || 'test'
  console.log(`[1/5] Looking up project slug=${slug} ...`)
  const project = await prisma.project.findUnique({
    where: { slug },
    select: { id: true, authMode: true, skipTranscoding: true },
  })
  if (!project) {
    console.error(`No project with slug=${slug}`)
    process.exit(1)
  }
  console.log(`     project.id=${project.id}, authMode=${project.authMode}, skipTranscoding=${project.skipTranscoding}`)

  console.log(`[2/5] Fetching share session via GET /api/share/${slug} ...`)
  const shareResp = await fetch(`${BASE_URL}/api/share/${slug}`, {
    headers: { 'Content-Type': 'application/json' },
  })
  console.log(`     status=${shareResp.status}`)
  if (!shareResp.ok) {
    const txt = await shareResp.text()
    console.error('Share endpoint failed:', txt.slice(0, 500))
    process.exit(1)
  }
  const shareJson: any = await shareResp.json()
  const shareToken: string = shareJson?.shareToken
  // The share endpoint returns the project payload at the top level
  // (videos is a sibling of shareToken/title/etc), not under a `.project` key.
  const videos: any[] = shareJson?.videos || shareJson?.project?.videos || []
  console.log(`     shareToken=${shareToken?.slice(0, 24)}...`)
  console.log(`     videos.count=${videos.length}`)
  console.log(`     top-level keys=${Object.keys(shareJson).join(',')}`)
  if (!shareToken) {
    console.error('No shareToken in /api/share response — share might require auth.')
    console.error('Response keys:', Object.keys(shareJson))
    process.exit(1)
  }
  if (!videos.length) {
    console.error('No videos in share response.')
    process.exit(1)
  }
  const v = videos[0]
  console.log(`     using video.id=${v.id}, name=${v.name}, approved=${v.approved}, status=${v.status}`)

  console.log(`[2.4/5] Probing Redis for revocation entries ...`)
  try {
    await redis.ping()
    console.log(`     redis.ping=OK`)
    const tokSig = shareToken.split('.').slice(-1)[0]
    const tokKey = `blacklist:token:${tokSig}`
    const tokExists = await redis.exists(tokKey)
    console.log(`     ${tokKey} exists? ${tokExists}`)
    // sessionId comes from the decoded token; let's pull it lazily later
    const decoded2 = jwt.decode(shareToken) as any
    const sid = decoded2?.sessionId
    if (sid) {
      const sidKey = `revoked:share_session:${sid}`
      const sidExists = await redis.exists(sidKey)
      console.log(`     ${sidKey} exists? ${sidExists}`)
    }
  } catch (err) {
    console.error(`     redis probe FAILED:`, (err as Error).message)
    console.error(`     -> If the dev server can't reach Redis either, getShareContext returns null and you get 401.`)
  }

  console.log(`[2.5/5] Manually verifying the share JWT we just received ...`)
  console.log(`     full token=${shareToken}`)
  const secret = process.env.SHARE_TOKEN_SECRET
  if (!secret) {
    console.error('     SHARE_TOKEN_SECRET is missing in the script environment!')
  } else {
    try {
      const decoded = jwt.verify(shareToken, secret, { algorithms: ['HS256'] }) as any
      console.log(`     decoded=`, decoded)
      const expSeconds = decoded.exp ? decoded.exp - Math.floor(Date.now() / 1000) : null
      console.log(`     expires in: ${expSeconds}s`)
    } catch (err) {
      console.error(`     jwt.verify FAILED:`, (err as Error).message)
      console.error(`     -> Sign/verify secret mismatch is the cause of the 401.`)
    }
  }

  console.log(`[3/5] Requesting 720p video token ...`)
  const tokenResp = await fetch(
    `${BASE_URL}/api/share/${slug}/video-token?videoId=${v.id}&quality=720p`,
    { headers: { Authorization: `Bearer ${shareToken}` } },
  )
  console.log(`     status=${tokenResp.status}`)
  const tokenBody = await tokenResp.json().catch(() => null)
  console.log(`     body=`, tokenBody)
  if (!tokenResp.ok || !tokenBody?.token) {
    console.error('Token request failed; cannot proceed.')
    process.exit(1)
  }
  const accessToken: string = tokenBody.token

  console.log(`[4/5] HEAD /api/content/${accessToken.slice(0, 16)}... ...`)
  const contentResp = await fetch(`${BASE_URL}/api/content/${accessToken}`, {
    method: 'HEAD',
  })
  console.log(`     status=${contentResp.status}`)
  console.log(`     Content-Type=${contentResp.headers.get('content-type')}`)
  console.log(`     Content-Length=${contentResp.headers.get('content-length')}`)
  console.log(`     Accept-Ranges=${contentResp.headers.get('accept-ranges')}`)

  if (!contentResp.ok) {
    console.log(`[5/5] Re-fetching with GET to read error body ...`)
    const errResp = await fetch(`${BASE_URL}/api/content/${accessToken}`)
    const errText = await errResp.text()
    console.log(`     body=${errText.slice(0, 500)}`)
  } else {
    console.log(`[5/5] OK — video should play. The blocker is on the client side, not the API.`)
  }
}

main()
  .catch((err) => {
    console.error('FAILED:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })
