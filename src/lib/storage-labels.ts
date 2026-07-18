/**
 * 4.2.0+ — client-safe labels for storage backends.
 *
 * Kept in its own module (no prisma / server imports) so client components
 * (VideoCard, VideoList) can render storage tags without pulling server-only
 * code into the browser bundle.
 */
export function storageBackendLabel(backend: string | null | undefined): string {
  switch (backend) {
    case 'local':
      return 'Local storage'
    case 'fc':
      return 'FrameComment Server'
    case 'r2':
      return 'Cloudflare R2'
    case 'aws':
      return 'AWS storage'
    default:
      // NULL / unknown = the instance default (local on a standard install).
      return 'Local storage'
  }
}

/**
 * All storage tags for a file. A file can live on more than one backend after a
 * "keep source" transfer — storageLocations is a comma-separated list; fall
 * back to the single storageBackend when it's empty.
 */
export function storageLocationLabels(
  storageBackend: string | null | undefined,
  storageLocations: string | null | undefined,
): string[] {
  const list = (storageLocations || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const backends = list.length ? list : storageBackend ? [storageBackend] : []
  if (backends.length === 0) return ['Default']
  return backends.map(storageBackendLabel)
}
