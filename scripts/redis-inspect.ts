/**
 * Quick inspector — sanity-checks what's actually in Redis right now and
 * how the SCAN cursor sees it. Useful when EXISTS returns 1 but SCAN
 * returns nothing (different db, eviction in flight, key with TTL, …).
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
  console.log(`Connected: ${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`)
  const dbsize = await redis.dbsize()
  console.log(`DBSIZE = ${dbsize}`)
  const info = await redis.info('keyspace')
  console.log('INFO keyspace =', info.trim())

  const exactKey = 'revoked:share_session:none:cmorcktj80004sup447qtainj:::1'
  console.log(`EXISTS '${exactKey}' = ${await redis.exists(exactKey)}`)
  const ttl = await redis.ttl(exactKey)
  console.log(`TTL    '${exactKey}' = ${ttl} (-2 = key missing, -1 = no expiry)`)

  console.log(`\nAll keys matching revoked:* via KEYS:`)
  const all = await redis.keys('revoked:*')
  for (const k of all) console.log('  ' + k)

  console.log(`\nAll keys via KEYS *share*:`)
  const all2 = await redis.keys('*share*')
  for (const k of all2) console.log('  ' + k)
}

main()
  .catch((err) => {
    console.error('FAILED:', err)
    process.exit(1)
  })
  .finally(() => redis.disconnect())
