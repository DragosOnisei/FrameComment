import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  ListMultipartUploadsCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  NotFound,
  type CompletedPart,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { Readable } from 'stream'
import type { S3BackendConfig } from './storage-backends'

// 4.2.0+: multi-backend. Every function accepts an OPTIONAL trailing
// `config: S3BackendConfig`. When omitted the legacy env-based S3 config
// (S3_* vars, i.e. the pre-4.2.0 single-bucket behaviour) is used, so every
// existing caller keeps working byte-for-byte. When a config is supplied the
// call targets that specific backend (fc / r2 / aws).

/** Per-config S3 client cache — one client per distinct bucket/endpoint/key. */
const _clients = new Map<string, S3Client>()

/** The legacy single-bucket config, read from the S3_* env vars. */
function legacyEnvConfig(): S3BackendConfig {
  const endpoint = process.env.S3_ENDPOINT?.trim()
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim()

  if (!endpoint) throw new Error('S3_ENDPOINT is not configured')
  if (!accessKeyId) throw new Error('S3_ACCESS_KEY_ID is not configured')
  if (!secretAccessKey) throw new Error('S3_SECRET_ACCESS_KEY is not configured')

  const bucket = process.env.S3_BUCKET
  if (!bucket) throw new Error('S3_BUCKET is not configured')

  return {
    endpoint,
    region: process.env.S3_REGION?.trim() || 'us-east-1',
    bucket,
    accessKeyId,
    secretAccessKey,
    // forcePathStyle: true for MinIO/Ceph. Set S3_FORCE_PATH_STYLE=false for AWS virtual-hosted buckets.
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
  }
}

function getS3Client(config?: S3BackendConfig): S3Client {
  const cfg = config ?? legacyEnvConfig()

  // Validate S3 endpoint is a proper HTTP(S) URL to prevent SSRF via misconfiguration
  if (cfg.endpoint) {
    try {
      const parsed = new URL(cfg.endpoint)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`S3 endpoint must use http or https (got ${parsed.protocol})`)
      }
    } catch (e) {
      if (e instanceof TypeError) {
        throw new Error(`S3 endpoint is not a valid URL: ${cfg.endpoint}`)
      }
      throw e
    }
  }

  const cacheKey = `${cfg.endpoint ?? 'aws'}|${cfg.region}|${cfg.bucket}|${cfg.accessKeyId}|${cfg.forcePathStyle}`
  const cached = _clients.get(cacheKey)
  if (cached) return cached

  const client = new S3Client({
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    region: cfg.region || 'us-east-1',
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    forcePathStyle: cfg.forcePathStyle,
    // SDK >= 3.729.0 defaults to sending x-amz-checksum-* headers on all requests.
    // MinIO (and Cloudflare R2, DigitalOcean Spaces, Backblaze B2) return 400/501
    // for these headers. WHEN_REQUIRED disables that default for all request types.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })

  _clients.set(cacheKey, client)
  return client
}

function getS3Bucket(config?: S3BackendConfig): string {
  if (config) return config.bucket
  const bucket = process.env.S3_BUCKET
  if (!bucket) throw new Error('S3_BUCKET is not configured')
  return bucket
}

function formatS3Error(operation: string, key: string, err: unknown): Error {
  const e = err as { $metadata?: { httpStatusCode?: number }; message?: string; name?: string }
  const status = e?.$metadata?.httpStatusCode
  const msg = e?.message ?? String(err)
  const name = e?.name ? `${e.name}: ` : ''
  return new Error(`[S3 ${operation}] key="${key}"${status ? ` HTTP ${status}` : ''} ${name}${msg}`)
}

/** Upload a buffer or stream — used by the worker for processed outputs.
 * For files >= 100MB, uses multipart upload to avoid request size limits.
 * Aligns with presign endpoint which uses 25MB default chunks.
 */
export async function s3UploadFile(
  key: string,
  body: Readable | Buffer,
  contentType: string = 'application/octet-stream',
  size?: number,
  config?: S3BackendConfig
): Promise<void> {
  // Use multipart upload for files >= 100MB
  const MULTIPART_THRESHOLD = 100 * 1024 * 1024 // 100MB
  const PART_SIZE = 25 * 1024 * 1024 // 25MB per part (matches presign endpoint)

  // If size is provided and exceeds threshold, use multipart
  if (size !== undefined && size >= MULTIPART_THRESHOLD) {
    return s3UploadFileMultipart(key, body, contentType, size, PART_SIZE, config)
  }

  // For unknown size streams, detect by reading first chunk
  if (size === undefined && body instanceof Readable) {
    // Peek at stream to detect if it's large enough for multipart
    const chunks: Buffer[] = []
    let totalSize = 0
    let readable = body
    const PART_SIZE = 25 * 1024 * 1024 // 25MB per part (matches presign endpoint)

    // Try to determine size from stream before committing to single PUT
    return new Promise((resolve, reject) => {
      let uploadedUsingMultipart = false

      readable.on('data', async (chunk: Buffer) => {
        chunks.push(chunk)
        totalSize += chunk.length

        // Switch to multipart mid-stream if size exceeds threshold
        if (!uploadedUsingMultipart && totalSize >= MULTIPART_THRESHOLD) {
          uploadedUsingMultipart = true
          readable.pause()

          try {
            const bufferBody = Buffer.concat(chunks)
            const uploadStream = Readable.from([bufferBody, readable])
            await s3UploadFileMultipart(key, uploadStream, contentType, totalSize, PART_SIZE, config)
            resolve()
          } catch (err) {
            reject(formatS3Error('PUT', key, err))
          }
        }
      })

      readable.on('end', async () => {
        if (!uploadedUsingMultipart) {
          try {
            const bufferBody = Buffer.concat(chunks)
            await getS3Client(config).send(
              new PutObjectCommand({ Bucket: getS3Bucket(config), Key: key, Body: bufferBody, ContentType: contentType })
            )
            resolve()
          } catch (err) {
            reject(formatS3Error('PUT', key, err))
          }
        }
      })

      readable.on('error', (err) => {
        reject(formatS3Error('PUT', key, err))
      })
    })
  }

  // Buffer or sized stream under threshold: use single PUT
  try {
    await getS3Client(config).send(
      new PutObjectCommand({ Bucket: getS3Bucket(config), Key: key, Body: body, ContentType: contentType })
    )
  } catch (err) {
    throw formatS3Error('PUT', key, err)
  }
}

/** Upload a file using multipart upload. Internal helper for large files. */
async function s3UploadFileMultipart(
  key: string,
  body: Readable | Buffer,
  contentType: string,
  totalSize: number,
  partSize: number = 25 * 1024 * 1024, // 25MB default (matches presign endpoint)
  config?: S3BackendConfig
): Promise<void> {
  let uploadId: string | undefined

  try {
    // Initiate multipart upload - reuse existing exported function
    uploadId = await s3InitiateMultipartUpload(key, contentType, config)

    const parts: CompletedPart[] = []
    const bucket = getS3Bucket(config)
    let partNumber = 1

    const uploadPart = async (chunk: Buffer) => {
      const uploadRes = await getS3Client(config).send(
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: chunk,
        })
      )
      if (!uploadRes.ETag) throw new Error(`Missing ETag for part ${partNumber}`)
      parts.push({ ETag: uploadRes.ETag, PartNumber: partNumber })
      partNumber++
    }

    if (Buffer.isBuffer(body)) {
      // Buffer source: slice into parts (no extra memory beyond the buffer).
      let offset = 0
      while (offset < body.length) {
        const end = Math.min(offset + partSize, body.length)
        await uploadPart(body.subarray(offset, end))
        offset = end
      }
    } else {
      // Stream source: accumulate into part-sized buffers and flush each as it
      // fills, so we never hold more than ~one part (25MB) in memory. This is
      // what makes migrating multi-GB masters to S3 safe (no whole-file buffer).
      let pending: Buffer[] = []
      let pendingLen = 0
      const flush = async () => {
        if (pendingLen === 0) return
        const chunk = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingLen)
        pending = []
        pendingLen = 0
        await uploadPart(chunk)
      }
      for await (const c of body as AsyncIterable<Buffer | string>) {
        const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c)
        pending.push(chunk)
        pendingLen += chunk.length
        if (pendingLen >= partSize) await flush()
      }
      await flush()
    }

    // Complete multipart upload - reuse existing exported function
    await s3CompleteMultipartUpload(key, uploadId, parts, config)
  } catch (err) {
    // Abort multipart upload on error to free storage - reuse existing exported function
    if (uploadId) {
      try {
        await s3AbortMultipartUpload(key, uploadId, config)
      } catch {
        // Ignore abort errors
      }
    }
    throw formatS3Error('PUT', key, err)
  }
}

/** Download an object as a readable stream — used by the worker. */
export async function s3DownloadFile(key: string, config?: S3BackendConfig): Promise<Readable> {
  let res
  try {
    res = await getS3Client(config).send(new GetObjectCommand({ Bucket: getS3Bucket(config), Key: key }))
  } catch (err) {
    throw formatS3Error('GET', key, err)
  }
  if (!res.Body) throw new Error(`S3 object body missing for key: ${key}`)
  return res.Body as Readable
}

/** Delete a single object. */
export async function s3DeleteFile(key: string, config?: S3BackendConfig): Promise<void> {
  try {
    await getS3Client(config).send(new DeleteObjectCommand({ Bucket: getS3Bucket(config), Key: key }))
  } catch (err) {
    throw formatS3Error('DELETE', key, err)
  }
}

/** Delete all objects under a key prefix (paginated). */
export async function s3DeleteDirectory(prefix: string, config?: S3BackendConfig): Promise<void> {
  const client = getS3Client(config)
  const bucket = getS3Bucket(config)
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`
  let continuationToken: string | undefined

  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: normalizedPrefix, ContinuationToken: continuationToken })
    )
    const objects = res.Contents ?? []
    if (objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects.map((o) => ({ Key: o.Key! })), Quiet: true },
        })
      )
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (continuationToken)
}

/** List every object key under a prefix (paginated). Used by the storage
 * transfer to enumerate HLS segment folders (which have no DB row per file). */
export async function s3ListKeys(prefix: string, config?: S3BackendConfig): Promise<string[]> {
  const client = getS3Client(config)
  const bucket = getS3Bucket(config)
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`
  const keys: string[] = []
  let continuationToken: string | undefined
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: normalizedPrefix, ContinuationToken: continuationToken })
    )
    for (const o of res.Contents ?? []) {
      if (o.Key) keys.push(o.Key)
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (continuationToken)
  return keys
}

/** Return the byte size of an object via HeadObject. */
export async function s3GetFileSize(key: string, config?: S3BackendConfig): Promise<number> {
  const res = await getS3Client(config).send(new HeadObjectCommand({ Bucket: getS3Bucket(config), Key: key }))
  if (res.ContentLength === undefined) {
    throw new Error(`S3 HeadObject returned no ContentLength for key: ${key}`)
  }
  return res.ContentLength
}

/** Return true if the object exists; false on 404; rethrows on any other error. */
export async function s3FileExists(key: string, config?: S3BackendConfig): Promise<boolean> {
  try {
    await getS3Client(config).send(new HeadObjectCommand({ Bucket: getS3Bucket(config), Key: key }))
    return true
  } catch (err: unknown) {
    // HeadObject throws NotFound (not NoSuchKey) per AWS SDK v3 spec
    if (err instanceof NotFound) return false
    // Some S3-compatible providers (MinIO, R2) surface 404 via $metadata instead
    const e = err as { $metadata?: { httpStatusCode?: number }; message?: string }
    if (e?.$metadata?.httpStatusCode === 404) return false
    const status = e?.$metadata?.httpStatusCode
    throw new Error(`S3 HeadObject failed for key "${key}"${status ? ` (HTTP ${status})` : ''}: ${e?.message ?? String(err)}`)
  }
}

// ─── Multipart upload ────────────────────────────────────────────────────────

/** Start a multipart upload and return the UploadId. */
export async function s3InitiateMultipartUpload(
  key: string,
  contentType: string = 'application/octet-stream',
  config?: S3BackendConfig
): Promise<string> {
  const res = await getS3Client(config).send(
    new CreateMultipartUploadCommand({ Bucket: getS3Bucket(config), Key: key, ContentType: contentType })
  )
  if (!res.UploadId) throw new Error('Failed to initiate multipart upload')
  return res.UploadId
}

/** Return a presigned PUT URL for one part of a multipart upload. */
export async function s3GetPresignedPartUrl(
  key: string,
  uploadId: string,
  partNumber: number,
  expirySeconds: number = 3600,
  config?: S3BackendConfig
): Promise<string> {
  return getSignedUrl(
    getS3Client(config),
    new UploadPartCommand({ Bucket: getS3Bucket(config), Key: key, UploadId: uploadId, PartNumber: partNumber }),
    { expiresIn: expirySeconds }
  )
}

/** Assemble a completed multipart upload from its parts. */
export async function s3CompleteMultipartUpload(
  key: string,
  uploadId: string,
  parts: CompletedPart[],
  config?: S3BackendConfig
): Promise<void> {
  await getS3Client(config).send(
    new CompleteMultipartUploadCommand({
      Bucket: getS3Bucket(config),
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    })
  )
}

/** Abort an incomplete multipart upload to free storage. */
export async function s3AbortMultipartUpload(key: string, uploadId: string, config?: S3BackendConfig): Promise<void> {
  await getS3Client(config).send(
    new AbortMultipartUploadCommand({ Bucket: getS3Bucket(config), Key: key, UploadId: uploadId })
  )
}

/** Abort all multipart uploads in the bucket that were initiated before cutoffDate. */
export async function s3AbortIncompleteMultipartUploadsOlderThan(
  cutoffDate: Date,
  config?: S3BackendConfig
): Promise<number> {
  const client = getS3Client(config)
  const bucket = getS3Bucket(config)

  let abortedCount = 0
  let keyMarker: string | undefined
  let uploadIdMarker: string | undefined

  do {
    const listRes = await client.send(
      new ListMultipartUploadsCommand({
        Bucket: bucket,
        KeyMarker: keyMarker,
        UploadIdMarker: uploadIdMarker,
      })
    )

    const uploads = listRes.Uploads ?? []
    for (const upload of uploads) {
      if (!upload.Key || !upload.UploadId || !upload.Initiated) {
        continue
      }

      if (upload.Initiated.getTime() >= cutoffDate.getTime()) {
        continue
      }

      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: upload.Key,
          UploadId: upload.UploadId,
        })
      )
      abortedCount++
    }

    keyMarker = listRes.IsTruncated ? listRes.NextKeyMarker : undefined
    uploadIdMarker = listRes.IsTruncated ? listRes.NextUploadIdMarker : undefined
  } while (keyMarker)

  return abortedCount
}

// ─── Presigned GET URLs ───────────────────────────────────────────────────────

/** Presigned download URL. Adds Content-Disposition when filename is provided. */
export async function s3GetPresignedDownloadUrl(
  key: string,
  expirySeconds: number = 3600,
  filename?: string,
  contentType?: string,
  config?: S3BackendConfig
): Promise<string> {
  return getSignedUrl(
    getS3Client(config),
    new GetObjectCommand({
      Bucket: getS3Bucket(config),
      Key: key,
      ...(filename && {
        ResponseContentDisposition:
          `attachment; filename="${filename.replace(/["\\]/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      }),
      ...(contentType && { ResponseContentType: contentType }),
    }),
    { expiresIn: expirySeconds }
  )
}

/** Presigned streaming URL (no Content-Disposition — browser plays inline). */
export async function s3GetPresignedStreamUrl(
  key: string,
  expirySeconds: number = 14400,
  contentType?: string,
  config?: S3BackendConfig
): Promise<string> {
  return getSignedUrl(
    getS3Client(config),
    new GetObjectCommand({
      Bucket: getS3Bucket(config),
      Key: key,
      ...(contentType && { ResponseContentType: contentType }),
    }),
    { expiresIn: expirySeconds }
  )
}
