// Local-dev entry point for the worker.
// Loads .env (or .env.local) BEFORE importing the real worker, so that
// modules like src/lib/storage.ts pick up STORAGE_ROOT, DATABASE_URL, etc.
// from the dotenv file. In Docker production we use src/worker/index.ts
// directly because env vars come from docker-compose.

import { existsSync } from 'fs'
import dotenv from 'dotenv'

const envFile = existsSync('.env.local')
  ? '.env.local'
  : existsSync('.env')
    ? '.env'
    : null

if (envFile) {
  dotenv.config({ path: envFile })
  console.log(`[dev] Loaded environment from ${envFile}`)
} else {
  console.warn('[dev] No .env or .env.local found. Worker may fail to start.')
}

// Dynamic import AFTER env is loaded — top-level imports would be hoisted
// to before the dotenv call, defeating the purpose.
import('./index').catch((err) => {
  console.error('Worker failed to start:', err)
  process.exit(1)
})
