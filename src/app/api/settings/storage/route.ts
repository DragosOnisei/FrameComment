import { NextRequest, NextResponse } from 'next/server'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { prisma } from '@/lib/db'
import { encrypt, decrypt } from '@/lib/encryption'
import { s3FileExists } from '@/lib/s3-storage'
import { refreshLocalStorageRoot } from '@/lib/storage'
import {
  isValidBackend,
  legacyBackend,
  type StorageBackend,
  type S3BackendConfig,
} from '@/lib/storage-backends'
import { logError } from '@/lib/logging'
import fs from 'fs'
import path from 'path'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 4.2.0+: Storage backend settings — read the active backend + the customer's
// R2 / AWS credentials, save them (secrets encrypted at rest), and test a
// connection before committing. Admin-only.

interface StorageSettingsRow {
  activeStorageBackend: string | null
  localStoragePath: string | null
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

async function readRow(): Promise<StorageSettingsRow | null> {
  const rows = await prisma.$queryRawUnsafe<Array<StorageSettingsRow>>(
    'SELECT "activeStorageBackend","localStoragePath","r2Endpoint","r2Region","r2Bucket","r2AccessKeyId","r2SecretAccessKey",' +
      '"awsRegion","awsBucket","awsAccessKeyId","awsSecretAccessKey" FROM "Settings" WHERE id = $1 LIMIT 1',
    'default',
  )
  return rows?.[0] ?? null
}

/** Validate a proposed local uploads folder: absolute, and creatable/writable. */
async function validateLocalPath(p: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!path.isAbsolute(p)) return { ok: false, error: 'Uploads folder must be an absolute path' }
  if (p.includes('\0')) return { ok: false, error: 'Invalid path' }
  try {
    await fs.promises.mkdir(p, { recursive: true })
    // Write + remove a probe file to confirm the app can write there.
    const probe = path.join(p, `.framecomment-write-test-${Date.now()}`)
    await fs.promises.writeFile(probe, 'ok')
    await fs.promises.unlink(probe).catch(() => {})
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: `Folder is not writable by the app: ${e?.message || e}` }
  }
}

// GET — current storage settings, secrets redacted to a "configured" boolean.
export async function GET(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  try {
    const row = await readRow()
    return NextResponse.json({
      // NULL activeStorageBackend means "follow the legacy env" — surface the
      // effective backend so the UI can preselect the right radio.
      activeStorageBackend: (row?.activeStorageBackend as StorageBackend | null) ?? null,
      effectiveBackend: isValidBackend(row?.activeStorageBackend)
        ? (row!.activeStorageBackend as StorageBackend)
        : legacyBackend(),
      localStoragePath: row?.localStoragePath ?? '',
      defaultLocalStoragePath: process.env.STORAGE_ROOT || '/app/uploads',
      r2: {
        endpoint: row?.r2Endpoint ?? '',
        region: row?.r2Region ?? 'auto',
        bucket: row?.r2Bucket ?? '',
        accessKeyId: row?.r2AccessKeyId ?? '',
        hasSecret: !!row?.r2SecretAccessKey,
      },
      aws: {
        region: row?.awsRegion ?? 'us-east-1',
        bucket: row?.awsBucket ?? '',
        accessKeyId: row?.awsAccessKeyId ?? '',
        hasSecret: !!row?.awsSecretAccessKey,
      },
    })
  } catch (error) {
    logError('[settings/storage GET] failed:', error)
    return NextResponse.json({ error: 'Failed to read storage settings' }, { status: 500 })
  }
}

function trimOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length ? t : null
}

/**
 * Build the S3 config to TEST from the request body, falling back to the
 * stored (encrypted) secret when the form left the secret blank (i.e. the
 * admin is re-testing without re-entering the key).
 */
function buildTestConfig(
  backend: 'r2' | 'aws',
  body: any,
  row: StorageSettingsRow | null,
): S3BackendConfig {
  if (backend === 'r2') {
    const b = body?.r2 ?? {}
    const endpoint = trimOrNull(b.endpoint) ?? row?.r2Endpoint ?? undefined
    const bucket = trimOrNull(b.bucket) ?? row?.r2Bucket ?? ''
    const accessKeyId = trimOrNull(b.accessKeyId) ?? row?.r2AccessKeyId ?? ''
    const secretRaw = trimOrNull(b.secretAccessKey)
    const secretAccessKey = secretRaw ?? (row?.r2SecretAccessKey ? decrypt(row.r2SecretAccessKey) : '')
    if (!endpoint) throw new Error('R2 endpoint is required')
    if (!bucket) throw new Error('R2 bucket is required')
    if (!accessKeyId) throw new Error('R2 access key ID is required')
    if (!secretAccessKey) throw new Error('R2 secret access key is required')
    return { endpoint, region: trimOrNull(b.region) ?? row?.r2Region ?? 'auto', bucket, accessKeyId, secretAccessKey, forcePathStyle: true }
  }
  const b = body?.aws ?? {}
  const region = trimOrNull(b.region) ?? row?.awsRegion ?? 'us-east-1'
  const bucket = trimOrNull(b.bucket) ?? row?.awsBucket ?? ''
  const accessKeyId = trimOrNull(b.accessKeyId) ?? row?.awsAccessKeyId ?? ''
  const secretRaw = trimOrNull(b.secretAccessKey)
  const secretAccessKey = secretRaw ?? (row?.awsSecretAccessKey ? decrypt(row.awsSecretAccessKey) : '')
  if (!bucket) throw new Error('AWS bucket is required')
  if (!accessKeyId) throw new Error('AWS access key ID is required')
  if (!secretAccessKey) throw new Error('AWS secret access key is required')
  return { endpoint: `https://s3.${region}.amazonaws.com`, region, bucket, accessKeyId, secretAccessKey, forcePathStyle: false }
}

// POST — either test a connection ({ action: 'test', backend }) or save.
export async function POST(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 30,
    message: 'Too many requests. Please slow down.',
  }, 'settings-storage')
  if (rateLimitResult) return rateLimitResult

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const row = await readRow()

  // ── Test connection ────────────────────────────────────────────────────────
  if (body?.action === 'test') {
    const backend = body?.backend
    if (backend !== 'r2' && backend !== 'aws') {
      return NextResponse.json({ error: 'Only R2 and AWS connections can be tested' }, { status: 400 })
    }
    try {
      const config = buildTestConfig(backend, body, row)
      // A HEAD on a random key returns false when creds+bucket are valid (the
      // object just doesn't exist) and throws on auth / bucket errors.
      await s3FileExists(`.framecomment-connection-test-${Date.now()}`, config)
      return NextResponse.json({ ok: true })
    } catch (error: any) {
      return NextResponse.json({ ok: false, error: error?.message || 'Connection failed' }, { status: 200 })
    }
  }

  // ── Save ─────────────────────────────────────────────────────────────────
  const activeStorageBackend = body?.activeStorageBackend
  if (activeStorageBackend != null && !isValidBackend(activeStorageBackend)) {
    return NextResponse.json({ error: 'Invalid storage backend' }, { status: 400 })
  }

  // Ensure the singleton row exists (typed upsert so DB-managed columns like
  // updatedAt are handled), then raw-UPDATE the storage columns so a stale
  // generated client still works.
  await prisma.settings.upsert({
    where: { id: 'default' },
    create: { id: 'default' },
    update: {},
  })

  const r2 = body?.r2 ?? {}
  const aws = body?.aws ?? {}

  // For secrets: only overwrite when a non-empty value is supplied; otherwise
  // keep whatever is already stored (blank form field = "leave unchanged").
  const r2Secret = trimOrNull(r2.secretAccessKey)
  const awsSecret = trimOrNull(aws.secretAccessKey)

  // 4.2.0+ (Phase 2d): local uploads folder. Empty → NULL (use env default).
  // A non-empty value must be an absolute, writable path.
  const localStoragePath = trimOrNull(body?.localStoragePath)
  if (localStoragePath) {
    const v = await validateLocalPath(localStoragePath)
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
  }

  try {
    await prisma.$executeRawUnsafe(
      'UPDATE "Settings" SET ' +
        '"activeStorageBackend" = $1, ' +
        '"r2Endpoint" = $2, "r2Region" = $3, "r2Bucket" = $4, "r2AccessKeyId" = $5, ' +
        '"r2SecretAccessKey" = COALESCE($6, "r2SecretAccessKey"), ' +
        '"awsRegion" = $7, "awsBucket" = $8, "awsAccessKeyId" = $9, ' +
        '"awsSecretAccessKey" = COALESCE($10, "awsSecretAccessKey"), ' +
        '"localStoragePath" = $11 ' +
        'WHERE id = $12',
      isValidBackend(activeStorageBackend) ? activeStorageBackend : null,
      trimOrNull(r2.endpoint),
      trimOrNull(r2.region) ?? 'auto',
      trimOrNull(r2.bucket),
      trimOrNull(r2.accessKeyId),
      r2Secret ? encrypt(r2Secret) : null,
      trimOrNull(aws.region) ?? 'us-east-1',
      trimOrNull(aws.bucket),
      trimOrNull(aws.accessKeyId),
      awsSecret ? encrypt(awsSecret) : null,
      localStoragePath,
      'default',
    )
    // Apply the new local root immediately (don't wait for the cache TTL).
    await refreshLocalStorageRoot()
    return NextResponse.json({ success: true })
  } catch (error) {
    logError('[settings/storage POST] save failed:', error)
    return NextResponse.json({ error: 'Failed to save storage settings' }, { status: 500 })
  }
}
