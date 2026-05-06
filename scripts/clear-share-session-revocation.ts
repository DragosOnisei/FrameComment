/**
 * Clears revoked share-session entries from Redis. For an `authMode=NONE`
 * project the share sessionId is deterministic (`none:<projectId>:<ip>`),
 * which means once it's marked revoked every freshly-issued JWT fails
 * verification — including the one the share endpoint hands the browser.
 * That's the actual reason the player gets stuck on "Loading video...".
 *
 * Usage:
 *
 *   # delete every revoked share-session
 *   npx tsx scripts/clear-share-session-revocation.ts
 *
 *   # or pass a single sessionId fragment to be surgical
 *   npx tsx scripts/clear-share-session-revocation.ts none:cmorcktj80004sup447qtainj
 */
import 'dotenv/config'
import { config as dotenvConfig } from 'dotenv'
import path from 'node:path'

dotenvConfig({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import IORedis from 'ioredis'

const redis = new IORedis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD,
})

async function main() {
  const filter = process.argv[2] || ''
  const pattern = filter
    ? `revoked:share_session:*${filter}*`
    : 'revoked:share_session:*'
  console.log(`Scanning for keys matching ${pattern} ...`)

  let cursor = '0'
  const found: string[] = []
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200)
    cursor = next
    found.push(...keys)
  } while (cursor !== '0')

  if (found.length === 0) {
    console.log('No matching keys.')
    return
  }

  console.log(`Found ${found.length} key(s):`)
  for (const k of found) console.log('  ' + k)

  const deleted = await redis.del(...found)
  console.log(`Deleted ${deleted} key(s).`)
}

main()
  .catch((err) => {
    console.error('FAILED:', err)
    process.exit(1)
  })
  .finally(() => redis.disconnect())
