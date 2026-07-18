/**
 * 4.2.0+ — Multi-backend storage resolution.
 *
 * FrameComment can store each file in one of four backends:
 *
 *   'local' — the app server's own disk (STORAGE_ROOT). Filesystem, no S3.
 *   'fc'    — a FrameComment-operated S3 bucket. Config comes from operator
 *             env vars (FC_S3_*, falling back to the legacy S3_* set), so the
 *             hosting operator controls it, never the customer. Billed per-GB.
 *   'r2'    — the customer's own Cloudflare R2 bucket. Config lives in the
 *             Settings row (secret encrypted at rest via lib/encryption).
 *   'aws'   — the customer's own AWS S3 bucket. Same, config in Settings.
 *
 * Two orthogonal questions this module answers:
 *
 *   1. Where do NEW writes go?   → getActiveBackend()  (Settings.activeStorageBackend)
 *   2. Where does an EXISTING    → resolveFileBackend(row.storageBackend)
 *      file live?
 *
 * Backward compatibility: every pre-4.2.0 row has storageBackend = NULL and
 * the Settings row has activeStorageBackend = NULL. Both fall back to
 * legacyBackend() — derived from the STORAGE_PROVIDER env — so an install
 * that never touches the new UI behaves exactly as it did before.
 */
import { prisma } from './db'
import { decrypt } from './encryption'

export type StorageBackend = 'local' | 'fc' | 'r2' | 'aws'

export const STORAGE_BACKENDS: readonly StorageBackend[] = ['local', 'fc', 'r2', 'aws'] as const

/** S3-compatible connection config for one backend ('fc' | 'r2' | 'aws'). */
export interface S3BackendConfig {
  endpoint?: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
}

export function isValidBackend(v: unknown): v is StorageBackend {
  return typeof v === 'string' && (STORAGE_BACKENDS as readonly string[]).includes(v)
}

/**
 * 4.2.0+ (Phase 2c): is the FrameComment Server ('fc') backend backed by an
 * S3 bucket, or by the operator's own local disk?
 *
 * When FC_S3_* (or the legacy S3_*) env is configured, 'fc' is a real S3
 * bucket. When it is NOT, 'fc' simply means "this server's own storage" and is
 * served from the local filesystem (STORAGE_ROOT) — this is the common case
 * for the hosted master instance whose disk *is* the FrameComment Server.
 */
export function fcUsesS3(): boolean {
  return !!((process.env.FC_S3_ENDPOINT || process.env.S3_ENDPOINT)?.trim())
}

/**
 * True when a backend is physically served from the local filesystem:
 * 'local' always, and 'fc' when it isn't S3-backed (operator's own disk).
 */
export function backendIsLocalFilesystem(b: StorageBackend): boolean {
  if (b === 'local') return true
  if (b === 'fc' && !fcUsesS3()) return true
  return false
}

/** True for any backend that talks S3 (i.e. not served from local disk). */
export function isS3Backend(b: StorageBackend): boolean {
  return !backendIsLocalFilesystem(b)
}

/**
 * The backend that pre-4.2.0 files (and installs that never picked one)
 * resolve to.
 *
 *  - `DEFAULT_STORAGE_BACKEND` env (when a valid backend) wins — the hosted
 *    master instance sets this to 'fc' so its disk reads as "FrameComment
 *    Server" and is billed per-GB.
 *  - Otherwise mirror the old isS3Mode() switch: STORAGE_PROVIDER=s3 → 'fc'
 *    (env S3 config), anything else → 'local'.
 */
export function legacyBackend(): StorageBackend {
  const forced = process.env.DEFAULT_STORAGE_BACKEND?.trim()
  if (isValidBackend(forced)) return forced
  return process.env.STORAGE_PROVIDER === 's3' ? 'fc' : 'local'
}

/**
 * Resolve which backend owns an already-stored file, from its saved
 * `storageBackend` column. NULL / unknown → the legacy env backend, so old
 * rows keep resolving to wherever they were actually written.
 */
export function resolveFileBackend(stored: string | null | undefined): StorageBackend {
  if (isValidBackend(stored)) return stored
  return legacyBackend()
}

/**
 * The backend that NEW uploads should be written to.
 *
 * Read via raw SQL so a stale generated Prisma client (a dev box that hasn't
 * re-run `prisma generate` after the 4.2.0 migration) still resolves it. If
 * the column is NULL or the read fails, fall back to the legacy env backend.
 */
export async function getActiveBackend(): Promise<StorageBackend> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ activeStorageBackend: string | null }>>(
      'SELECT "activeStorageBackend" FROM "Settings" WHERE id = $1 LIMIT 1',
      'default',
    )
    const v = rows?.[0]?.activeStorageBackend
    if (isValidBackend(v)) return v
  } catch {
    // Table/column missing or DB unreachable — fall through to legacy.
  }
  return legacyBackend()
}

function required(value: string | null | undefined, label: string): string {
  const v = value?.trim()
  if (!v) throw new Error(`${label} is not configured`)
  return v
}

/** FC (operator-hosted) S3 config: FC_S3_* env, falling back to legacy S3_*. */
function getFcS3Config(): S3BackendConfig {
  const endpoint = (process.env.FC_S3_ENDPOINT || process.env.S3_ENDPOINT)?.trim()
  const accessKeyId = (process.env.FC_S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID)?.trim()
  const secretAccessKey = (process.env.FC_S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY)?.trim()
  const bucket = (process.env.FC_S3_BUCKET || process.env.S3_BUCKET)?.trim()
  const region = (process.env.FC_S3_REGION || process.env.S3_REGION)?.trim() || 'us-east-1'
  // Path-style default matches the legacy S3 client (true unless explicitly 'false').
  const forcePathStyleRaw = process.env.FC_S3_FORCE_PATH_STYLE ?? process.env.S3_FORCE_PATH_STYLE

  if (!endpoint) throw new Error('FrameComment storage endpoint (FC_S3_ENDPOINT / S3_ENDPOINT) is not configured')
  if (!accessKeyId) throw new Error('FrameComment storage access key is not configured')
  if (!secretAccessKey) throw new Error('FrameComment storage secret key is not configured')
  if (!bucket) throw new Error('FrameComment storage bucket is not configured')

  return { endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle: forcePathStyleRaw !== 'false' }
}

interface SettingsS3Row {
  r2Endpoint: string | null
  r2Region: string | null
  r2Bucket: string | null
  r2AccessKeyId: string | null
  r2SecretAccessKey: string | null
  awsRegion: string | null
  awsBucket: string | null
  awsAccessKeyId: string | null
  awsSecretAccessKey: string | null
}

async function readSettingsS3Row(): Promise<SettingsS3Row | null> {
  const rows = await prisma.$queryRawUnsafe<Array<SettingsS3Row>>(
    'SELECT "r2Endpoint","r2Region","r2Bucket","r2AccessKeyId","r2SecretAccessKey",' +
      '"awsRegion","awsBucket","awsAccessKeyId","awsSecretAccessKey" ' +
      'FROM "Settings" WHERE id = $1 LIMIT 1',
    'default',
  )
  return rows?.[0] ?? null
}

/**
 * Build the S3 connection config for an S3-type backend. Throws for 'local'
 * (which has no S3 config) and when required credentials are missing.
 *
 * FC config comes from operator env; R2/AWS config is read from the Settings
 * row, with the secret access key decrypted here at the point of use.
 */
export async function getS3ConfigForBackend(backend: StorageBackend): Promise<S3BackendConfig> {
  if (backend === 'local') {
    throw new Error('The local backend has no S3 configuration')
  }
  if (backend === 'fc') {
    return getFcS3Config()
  }

  const s = await readSettingsS3Row()
  if (!s) throw new Error('Storage settings row not found')

  if (backend === 'r2') {
    return {
      endpoint: required(s.r2Endpoint, 'R2 endpoint'),
      region: s.r2Region?.trim() || 'auto',
      bucket: required(s.r2Bucket, 'R2 bucket'),
      accessKeyId: required(s.r2AccessKeyId, 'R2 access key ID'),
      secretAccessKey: decrypt(required(s.r2SecretAccessKey, 'R2 secret access key')),
      // R2 is S3-compatible and expects path-style addressing.
      forcePathStyle: true,
    }
  }

  // backend === 'aws'
  const region = s.awsRegion?.trim() || 'us-east-1'
  return {
    endpoint: `https://s3.${region}.amazonaws.com`,
    region,
    bucket: required(s.awsBucket, 'AWS bucket'),
    accessKeyId: required(s.awsAccessKeyId, 'AWS access key ID'),
    secretAccessKey: decrypt(required(s.awsSecretAccessKey, 'AWS secret access key')),
    // AWS S3 uses virtual-hosted-style addressing.
    forcePathStyle: false,
  }
}

/**
 * DB-backed per-entity backend resolution for the worker and content routes.
 *
 * Each stored file carries a `storageBackend` column on its owning row; this
 * reads it (via raw SQL, so a stale generated client still works) and falls
 * back to the legacy env backend when NULL/absent. The table name comes from
 * a fixed whitelist — never from user input — so the raw interpolation is safe.
 */
const BACKEND_TABLES = {
  video: 'Video',
  asset: 'VideoAsset',
  projectUpload: 'ProjectUpload',
  document: 'FolderDocument',
} as const

export type BackendEntity = keyof typeof BACKEND_TABLES

export async function getEntityBackend(kind: BackendEntity, id: string): Promise<StorageBackend> {
  const table = BACKEND_TABLES[kind]
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ storageBackend: string | null }>>(
      `SELECT "storageBackend" FROM "${table}" WHERE id = $1 LIMIT 1`,
      id,
    )
    return resolveFileBackend(rows?.[0]?.storageBackend)
  } catch {
    return legacyBackend()
  }
}

/** Convenience wrapper for the most common case. */
export function getVideoBackend(videoId: string): Promise<StorageBackend> {
  return getEntityBackend('video', videoId)
}

/**
 * Resolve a read/serve target for an already-stored file, from its saved
 * `storageBackend` value. Used by content/download routes that stream local
 * files directly but presign against S3-type backends.
 *
 *  - local            → { isS3: false }
 *  - legacy env-S3    → { isS3: true, config: undefined } (stored NULL, env
 *                        resolves to 'fc'): use the env-based S3 client, i.e.
 *                        byte-identical to the pre-4.2.0 behaviour.
 *  - explicit fc/r2/aws → { isS3: true, config } built for that backend.
 */
export async function resolveReadTarget(
  stored: string | null | undefined,
): Promise<{ backend: StorageBackend; isS3: boolean; config?: S3BackendConfig }> {
  const explicit = isValidBackend(stored) ? stored : null
  const backend = explicit ?? legacyBackend()
  // Local disk: 'local', or 'fc' when it isn't S3-backed (operator's own disk).
  if (backendIsLocalFilesystem(backend)) return { backend, isS3: false }
  // Legacy env-S3 (stored NULL, resolved to fc via STORAGE_PROVIDER=s3): use the
  // env-based client, byte-identical to pre-4.2.0.
  if (!explicit) return { backend, isS3: true, config: undefined }
  return { backend, isS3: true, config: await getS3ConfigForBackend(backend) }
}

/**
 * 4.2.0+ (Phase 2b) — a file can physically live on more than one backend
 * (e.g. after a "transfer + keep source"). storageLocations stores them
 * comma-separated. These parse/format helpers keep that list normalized.
 */
export function parseLocations(raw: string | null | undefined): StorageBackend[] {
  if (!raw) return []
  const out: StorageBackend[] = []
  for (const part of raw.split(',')) {
    const v = part.trim()
    if (isValidBackend(v) && !out.includes(v)) out.push(v)
  }
  return out
}

/** Comma-separated form, or NULL when it's a single location (use storageBackend). */
export function formatLocations(locs: StorageBackend[]): string | null {
  const uniq = Array.from(new Set(locs))
  return uniq.length > 1 ? uniq.join(',') : null
}

/**
 * Every backend a file physically lives on — the parsed storageLocations list,
 * always including the primary (storageBackend). Used by deletion so a file
 * that was kept on two backends (after a keep-source transfer) is fully removed.
 */
export function allFileLocations(
  storageBackend: string | null | undefined,
  storageLocations: string | null | undefined,
): StorageBackend[] {
  const parsed = parseLocations(storageLocations)
  const primary = resolveFileBackend(storageBackend)
  const set = parsed.length ? [...parsed] : [primary]
  if (!set.includes(primary)) set.push(primary)
  return set
}

/**
 * A human-readable "mount path" / location descriptor for a backend, WITHOUT
 * any secret (endpoint + bucket for S3-type; the disk root for local/fc-local).
 * `localRoot` is passed in by the caller (it lives in the storage module).
 */
export async function describeBackend(backend: StorageBackend, localRoot: string): Promise<string> {
  if (backend === 'local') return localRoot
  if (backend === 'fc') {
    if (!fcUsesS3()) return localRoot // operator's own disk
    const ep = (process.env.FC_S3_ENDPOINT || process.env.S3_ENDPOINT || '').trim()
    const bk = (process.env.FC_S3_BUCKET || process.env.S3_BUCKET || '').trim()
    return bk ? `${bk}${ep ? ` @ ${ep}` : ''}` : (ep || 'FrameComment Server')
  }
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{
      r2Endpoint: string | null; r2Bucket: string | null
      awsBucket: string | null; awsRegion: string | null
    }>>(
      'SELECT "r2Endpoint","r2Bucket","awsBucket","awsRegion" FROM "Settings" WHERE id = $1 LIMIT 1',
      'default',
    )
    const s = rows?.[0]
    if (backend === 'r2') {
      const bk = s?.r2Bucket?.trim()
      const ep = s?.r2Endpoint?.trim()
      return bk ? `${bk}${ep ? ` @ ${ep}` : ''}` : (ep || 'Cloudflare R2')
    }
    if (backend === 'aws') {
      const bk = s?.awsBucket?.trim()
      const region = s?.awsRegion?.trim()
      return bk ? `s3://${bk}${region ? ` (${region})` : ''}` : 'AWS S3'
    }
  } catch {
    /* fall through to the plain label */
  }
  return backendLabel(backend)
}

/** Human-readable label for a backend (for UI / per-video info). */
export function backendLabel(b: StorageBackend): string {
  switch (b) {
    case 'local':
      return 'Local Storage'
    case 'fc':
      return 'FrameComment Server'
    case 'r2':
      return 'Cloudflare R2'
    case 'aws':
      return 'AWS S3'
  }
}
