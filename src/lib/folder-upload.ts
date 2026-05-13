/**
 * Folder-drag-and-drop helpers (1.0.6+).
 *
 * The browser's File API gives us two paths for getting files out of a
 * dropped folder: the modern File System Access entries exposed by
 * `dataTransfer.items[i].webkitGetAsEntry()`, and the legacy
 * `webkitRelativePath` property set on `File` objects that come from
 * `<input type="file" webkitdirectory>`. This module normalises both
 * into the same `{ file, relativePath }` shape so the rest of the app
 * doesn't have to care which source the user picked.
 *
 * `relativePath` is always POSIX-style and includes the file name —
 * e.g. for a dropped folder named "Project A" with `Subfolder/B.mp4`
 * inside, the entry comes back as
 *   { file: <B.mp4>, relativePath: "Project A/Subfolder/B.mp4" }
 *
 * The leading directory in `relativePath` is preserved so callers can
 * decide whether to recreate that level as its own folder in the
 * destination (yes when dropping at project root; yes inside an
 * existing folder too — the user's intent is "mirror what I dropped").
 */

import { FILE_LIMITS } from './file-validation'
import { apiPost } from './api-client'

export interface FileTreeEntry {
  file: File
  /** Relative POSIX path including the file name, e.g. "Outer/Inner/v.mp4". */
  relativePath: string
}

/**
 * Returns `true` for files we want to upload. We currently accept the
 * project's standard video extensions (see `FILE_LIMITS`). Hidden /
 * system files like `.DS_Store` or `Thumbs.db` are rejected.
 */
export function isAcceptedVideoFile(file: File): boolean {
  const name = file.name
  if (!name || name.startsWith('.')) return false
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot <= 0) return false
  const ext = lower.slice(dot)
  return FILE_LIMITS.ALLOWED_EXTENSIONS.includes(ext)
}

/**
 * Recursively walk a `FileSystemEntry` (from `webkitGetAsEntry`) and
 * push every regular file into `output`. Directory order is not
 * guaranteed but every file's `relativePath` reflects the dropped
 * hierarchy verbatim.
 */
async function walkEntry(
  entry: FileSystemEntry,
  parentPath: string,
  output: FileTreeEntry[],
): Promise<void> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry
    await new Promise<void>((resolve) => {
      fileEntry.file(
        (file) => {
          const relativePath = parentPath
            ? `${parentPath}/${file.name}`
            : file.name
          output.push({ file, relativePath })
          resolve()
        },
        () => resolve(),
      )
    })
    return
  }
  if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry
    const reader = dirEntry.createReader()
    // readEntries() may return results in batches; loop until empty.
    let done = false
    while (!done) {
      const batch: FileSystemEntry[] = await new Promise((resolve) => {
        reader.readEntries(
          (entries) => resolve(entries),
          () => resolve([]),
        )
      })
      if (batch.length === 0) {
        done = true
        break
      }
      const nextPath = parentPath ? `${parentPath}/${entry.name}` : entry.name
      for (const child of batch) {
        await walkEntry(child, nextPath, output)
      }
    }
  }
}

/**
 * Synchronously snapshot every dropped item into FileSystemEntry
 * objects. This MUST be called inside the drop handler before any
 * `await` — browsers invalidate `DataTransferItem` references as
 * soon as the synchronous portion of the handler returns, so calling
 * `webkitGetAsEntry()` later (e.g. after an `await`) yields `null`.
 */
export function snapshotDataTransferEntries(
  items: DataTransferItemList,
): FileSystemEntry[] | null {
  if (!items || items.length === 0) return null
  const list = Array.from(items)
  const supportsEntry = list.some(
    (item) =>
      'webkitGetAsEntry' in item &&
      typeof (item as DataTransferItem).webkitGetAsEntry === 'function',
  )
  if (!supportsEntry) return null
  const entries: FileSystemEntry[] = []
  for (const item of list) {
    if (item.kind !== 'file') continue
    const entry = item.webkitGetAsEntry?.()
    if (entry) entries.push(entry)
  }
  return entries
}

/**
 * Walk a pre-snapshotted list of `FileSystemEntry`s into a flat list
 * of `{ file, relativePath }` and a flag indicating whether any of
 * the roots were directories. The snapshot MUST come from
 * `snapshotDataTransferEntries` so the references survive across the
 * awaits inside this function.
 */
export async function walkSnapshotEntries(
  rootEntries: FileSystemEntry[],
): Promise<{ entries: FileTreeEntry[]; hadDirectory: boolean }> {
  const entries: FileTreeEntry[] = []
  let hadDirectory = false
  for (const root of rootEntries) {
    if (root.isDirectory) hadDirectory = true
    await walkEntry(root, '', entries)
  }
  return { entries, hadDirectory }
}

/**
 * Convert files coming from `<input type="file" webkitdirectory>` into
 * the same shape as `walkDataTransferItems`. The browser already sets
 * `webkitRelativePath` for us; we just normalise it.
 */
export function entriesFromInputFiles(files: File[]): FileTreeEntry[] {
  return files
    .map((file) => ({
      file,
      // When the input is a plain file picker, webkitRelativePath is
      // empty — treat as a top-level file.
      relativePath: (file as any).webkitRelativePath || file.name,
    }))
    .filter((e) => e.relativePath.length > 0)
}

/**
 * From a list of file entries, derive the unique directory paths that
 * need to exist in FrameComment so each file can be uploaded into the
 * folder that mirrors its source location. The list is sorted from
 * shallowest to deepest so callers can create folders top-down (each
 * child can look up its parent's freshly-minted id in a single pass).
 */
export function uniqueDirectoryPaths(entries: FileTreeEntry[]): string[] {
  const set = new Set<string>()
  for (const entry of entries) {
    const dir = entry.relativePath.replace(/\/[^/]*$/, '')
    // No slash means file was at the top level — nothing to create.
    if (!dir || dir === entry.relativePath) continue
    // Collect every prefix so deep nests get every intermediate.
    const parts = dir.split('/')
    for (let i = 1; i <= parts.length; i++) {
      set.add(parts.slice(0, i).join('/'))
    }
  }
  return Array.from(set).sort((a, b) => {
    const da = a.split('/').length
    const db = b.split('/').length
    if (da !== db) return da - db
    return a.localeCompare(b)
  })
}

/**
 * Create every folder in `paths` under `rootFolderId` (which itself
 * lives in `projectId`). Folders are created sequentially so a child
 * can use its parent's id, and the returned map can be looked up by
 * the same relative path the caller already computed.
 *
 * Set `rootFolderId` to `null` to create folders at the project root.
 */
export async function createFolderHierarchy(
  projectId: string,
  rootFolderId: string | null,
  paths: string[],
): Promise<Map<string, string>> {
  // pathToFolderId always resolves a relative path to the
  // FrameComment folder id we just created (or already had). The empty
  // string maps to the root.
  const pathToFolderId = new Map<string, string>()
  pathToFolderId.set('', rootFolderId ?? '')

  for (const path of paths) {
    if (pathToFolderId.has(path)) continue
    const lastSlash = path.lastIndexOf('/')
    const parentPath = lastSlash === -1 ? '' : path.slice(0, lastSlash)
    const name = lastSlash === -1 ? path : path.slice(lastSlash + 1)
    const parentFolderId = pathToFolderId.get(parentPath) || null
    const body: Record<string, unknown> = { projectId, name }
    if (parentFolderId) body.parentFolderId = parentFolderId
    const res = await apiPost('/api/folders', body)
    const folder = res?.folder ?? res
    if (!folder?.id) {
      throw new Error(`Failed to create folder "${path}"`)
    }
    pathToFolderId.set(path, folder.id)
  }

  // Let any FolderBrowser mounted on the page refetch so the brand
  // new folders show up immediately, without waiting for a manual
  // refresh. We dispatch on `window` because the listener may live in
  // a sibling component tree (1.0.7+).
  if (typeof window !== 'undefined' && paths.length > 0) {
    window.dispatchEvent(new Event('framecomment:folders-changed'))
  }

  return pathToFolderId
}
