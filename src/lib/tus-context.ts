/**
 * TUS Context Tracking
 *
 * Ensures same file uploaded to different videos/projects gets fresh upload.
 * Clears TUS fingerprints when context changes to prevent resuming wrong upload.
 */

/**
 * Generate TUS fingerprint for a file (matches TUS library format exactly)
 * TUS format: tus-br-{name}-{type}-{size}-{lastModified}-{endpoint}
 */
export function generateFileFingerprint(file: File, endpoint?: string): string {
  const tusEndpoint = endpoint || (typeof window !== 'undefined' ? `${window.location.origin}/api/uploads` : '/api/uploads')
  return ['tus-br', file.name, file.type, file.size, file.lastModified, tusEndpoint].join('-')
}

const UPLOAD_META_PREFIX = 'framecomment-upload:'

export interface StoredUploadMetadata {
  videoId: string
  projectId?: string
  assetId?: string
  versionLabel?: string
  category?: string
  targetName?: string
  createdAt: number
}

function getUploadMetadataKey(file: File, endpoint?: string): string {
  const fingerprint = generateFileFingerprint(file, endpoint)
  return `${UPLOAD_META_PREFIX}${fingerprint}`
}

/**
 * Get TUS fingerprint key for a file
 * TUS stores with keys like: "tus::{fingerprint}::..."
 */
function getTUSFingerprintKey(file: File, endpoint?: string): string | null {
  const fingerprint = generateFileFingerprint(file, endpoint)

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && key.startsWith('tus::') && key.includes(fingerprint)) {
      return key
    }
  }

  return null
}

/**
 * Clear TUS fingerprint for a file
 */
export function clearTUSFingerprint(file: File): void {
  try {
    const key = getTUSFingerprintKey(file)
    if (key) {
      localStorage.removeItem(key)
    }
  } catch (error) {
    // Silent failure
  }
}

/**
 * Check if TUS has a fingerprint for this file
 */
export function hasTUSFingerprint(file: File): boolean {
  return getTUSFingerprintKey(file) !== null
}

/**
 * Store context (videoId/projectId) for a file
 */
export function storeFileContext(file: File, context: string): void {
  try {
    const fingerprint = generateFileFingerprint(file)
    const key = `framecomment-context:${fingerprint}`
    localStorage.setItem(key, context)
  } catch (error) {
    // Silent failure
  }
}

/**
 * Get stored context for a file
 */
export function getFileContext(file: File): string | null {
  try {
    const fingerprint = generateFileFingerprint(file)
    const key = `framecomment-context:${fingerprint}`
    return localStorage.getItem(key)
  } catch (error) {
    return null
  }
}

/**
 * Clear file context (call on upload success)
 */
export function clearFileContext(file: File): void {
  try {
    const fingerprint = generateFileFingerprint(file)
    const key = `framecomment-context:${fingerprint}`
    localStorage.removeItem(key)
  } catch (error) {
    // Silent failure
  }
}

/**
 * Check if file context has changed and clear TUS if needed
 */
export function ensureFreshUploadOnContextChange(file: File, newContext: string): void {
  const lastContext = getFileContext(file)

  if (lastContext && lastContext !== newContext) {
    // Context changed! Clear TUS fingerprint to force fresh upload
    clearTUSFingerprint(file)
    clearUploadMetadata(file)
  }

  // Store new context
  storeFileContext(file, newContext)
}

/**
 * Clear all stale context data (older than 7 days)
 */
export function clearStaleContextData(): void {
  try {
    const keysToRemove: string[] = []

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith('framecomment-context:')) {
        // Remove all context keys (they don't have timestamps, so remove all on cleanup)
        keysToRemove.push(key)
      }
    }

    keysToRemove.forEach(key => localStorage.removeItem(key))
  } catch (error) {
    // Silent failure
  }
}

/**
 * Store upload metadata so we can resume with the same video record after refresh
 */
export function storeUploadMetadata(
  file: File,
  metadata: Omit<StoredUploadMetadata, 'createdAt'>,
  endpoint?: string
): void {
  try {
    const key = getUploadMetadataKey(file, endpoint)
    const payload: StoredUploadMetadata = {
      ...metadata,
      createdAt: Date.now(),
    }
    localStorage.setItem(key, JSON.stringify(payload))
  } catch {
    // Silent failure
  }
}

/**
 * Get stored upload metadata for a file (clears stale entries older than 7 days)
 */
export function getUploadMetadata(file: File, endpoint?: string): StoredUploadMetadata | null {
  try {
    const key = getUploadMetadataKey(file, endpoint)
    const raw = localStorage.getItem(key)
    if (!raw) return null

    const metadata = JSON.parse(raw) as StoredUploadMetadata
    const oneWeekMs = 7 * 24 * 60 * 60 * 1000

    if (!metadata?.videoId) {
      localStorage.removeItem(key)
      return null
    }

    if (metadata.createdAt && Date.now() - metadata.createdAt > oneWeekMs) {
      localStorage.removeItem(key)
      return null
    }

    return metadata
  } catch {
    return null
  }
}

/**
 * Clear upload metadata for a file
 */
export function clearUploadMetadata(file: File, endpoint?: string): void {
  try {
    const key = getUploadMetadataKey(file, endpoint)
    localStorage.removeItem(key)
  } catch {
    // Silent failure
  }
}


/**
 * 6.14.0 — unfinished uploads left behind by a page refresh.
 *
 * A reload destroys the `File` the browser handed us, and there is no way to
 * get it back without the user picking it again: a page cannot reopen a file
 * by path, deliberately. So a transfer can never resume *fully* on its own.
 *
 * Everything else survives, though. The TUS session on the server still holds
 * the bytes and the exact offset, and the fingerprint is still in
 * localStorage. All that is missing is the file handle — so instead of losing
 * the transfer we can ask for that one thing back and carry on from where it
 * stopped.
 *
 * The fingerprint doubles as the record of what to ask for: it is built from
 * name, type, size and lastModified, so we can read those straight back out of
 * the key and match the file the user picks against them.
 */
export interface ResumableUpload {
  videoId: string
  projectId?: string
  targetName?: string
  versionLabel?: string
  fileName: string
  fileSize: number
  lastModified: number
  createdAt: number
}

export function listResumableUploads(projectId?: string): ResumableUpload[] {
  if (typeof window === 'undefined') return []
  const out: ResumableUpload[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(UPLOAD_META_PREFIX)) continue

      const raw = localStorage.getItem(key)
      if (!raw) continue
      let meta: StoredUploadMetadata
      try {
        meta = JSON.parse(raw)
      } catch {
        continue
      }
      if (!meta?.videoId) continue
      if (projectId && meta.projectId && meta.projectId !== projectId) continue
      // Assets and reverse-share uploads are not resumable this way.
      if (meta.assetId) continue

      // `tus-br-<name>-<type>-<size>-<lastModified>-<endpoint>`. The name can
      // itself contain dashes, so read the tail positionally: endpoint last,
      // then lastModified, size, type — whatever is left is the name.
      const fingerprint = key.slice(UPLOAD_META_PREFIX.length)
      const parts = fingerprint.split('-')
      if (parts.length < 6) continue
      const lastModified = Number(parts[parts.length - 2])
      const fileSize = Number(parts[parts.length - 3])
      if (!Number.isFinite(fileSize) || fileSize <= 0) continue

      out.push({
        videoId: meta.videoId,
        projectId: meta.projectId,
        targetName: meta.targetName,
        versionLabel: meta.versionLabel,
        fileName: meta.targetName || 'Unfinished upload',
        fileSize,
        lastModified: Number.isFinite(lastModified) ? lastModified : 0,
        createdAt: meta.createdAt || 0,
      })
    }
  } catch {
    // Storage disabled — nothing to offer.
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

/** Does the file the user just picked match the one we are waiting for? */
export function matchesResumable(file: File, entry: ResumableUpload): boolean {
  return file.size === entry.fileSize
}

/** Forget an offer — the row is gone, or the user dismissed it. */
export function forgetResumable(entry: ResumableUpload): void {
  if (typeof window === 'undefined') return
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(UPLOAD_META_PREFIX)) continue
      const raw = localStorage.getItem(key)
      if (raw && raw.includes(entry.videoId)) {
        const fingerprint = key.slice(UPLOAD_META_PREFIX.length)
        localStorage.removeItem(key)
        // The tus entry keyed by the same fingerprint has to go too, or the
        // next attempt resumes a session we just decided to abandon.
        for (let j = localStorage.length - 1; j >= 0; j--) {
          const tusKey = localStorage.key(j)
          if (tusKey && tusKey.startsWith('tus::') && tusKey.includes(fingerprint)) {
            localStorage.removeItem(tusKey)
          }
        }
      }
    }
  } catch {
    // Best effort.
  }
}
