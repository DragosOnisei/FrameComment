/**
 * 7.13.0: the files a paste or a drop carries, read the same way everywhere.
 *
 * Pasting an image into the comment box has attached it since 4.1.1, but the
 * reader looked at `clipboardData.items` alone and kept only entries whose
 * MIME type began with `image/`. Real clipboards are messier: a file copied
 * in the Finder arrives with its type sometimes empty, and some browsers fill
 * `files` but not `items`. So a paste that "did nothing" was a paste whose
 * image hid behind an empty type. This reads both lists, accepts a file by
 * type OR by extension, de-duplicates the two views of the same file, and
 * gives an unnamed blob (a screenshot straight from the clipboard) a name the
 * uploader and the storage can live with. Pure, so a script exercises it.
 */

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|avif|svg)$/i

export interface ClipboardLike {
  items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }> | null
  files?: ArrayLike<File> | null
}

export function looksLikeImage(file: { type: string; name: string }): boolean {
  return file.type.startsWith('image/') || IMAGE_EXT_RE.test(file.name || '')
}

/** A stable identity for "the same file seen through items and through files". */
function fileKey(f: File): string {
  return `${f.name}|${f.size}|${f.type}|${f.lastModified}`
}

/** Give a nameless clipboard blob a filename with the right extension. */
export function nameClipboardFile(file: File, now: number = Date.now()): File {
  const hasExt = !!file.name && /\.[a-z0-9]+$/i.test(file.name)
  if (hasExt) return file
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
  return new File([file], `pasted-${now}.${ext}`, { type: file.type || 'image/png' })
}

/** Every image file on a paste, from both `items` and `files`, each once. */
export function extractImageFiles(dt: ClipboardLike, now: number = Date.now()): File[] {
  const out: File[] = []
  const seen = new Set<string>()
  const push = (f: File | null) => {
    if (!f || !looksLikeImage(f)) return
    const key = fileKey(f)
    if (seen.has(key)) return
    seen.add(key)
    out.push(nameClipboardFile(f, now))
  }
  const items = dt.items ? Array.from(dt.items) : []
  for (const item of items) {
    if (item.kind === 'file') push(item.getAsFile())
  }
  const files = dt.files ? Array.from(dt.files) : []
  for (const f of files) push(f)
  return out
}

/** Whether a drag carries OS files (as opposed to an in-app card). */
export function isFileDrag(types: ArrayLike<string> | null | undefined): boolean {
  return !!types && Array.from(types).includes('Files')
}
