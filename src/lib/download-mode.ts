/**
 * 6.10.0 — when a folder download should be files rather than a ZIP.
 *
 * A shared folder with no subfolders and a handful of clips doesn't need an
 * archive: the browser can just download the files. That is better in three
 * concrete ways, not only tidier —
 *
 *   1. native per-file progress, and the browser can resume a broken one;
 *   2. no server-side zipping at all;
 *   3. it sidesteps the download manager's ceiling, which buffers the WHOLE
 *      archive in browser memory before saving it. A 20 GB folder is not
 *      downloadable as a ZIP today; as files it is.
 *
 * The limits are real, so they are encoded here rather than discovered later:
 *   - Subfolders MUST become a ZIP. Loose files would lose the structure, and
 *     a client who asked for a folder tree and got 40 files in Downloads has
 *     been given a worse thing.
 *   - Chrome asks permission the first time a site downloads several files.
 *     Callers must handle a refusal visibly instead of looking broken.
 *   - Past ~15 files the drip of downloads is worse than one archive.
 */

/** Above this many files, one archive beats a queue of downloads. */
export const DIRECT_DOWNLOAD_MAX_FILES = 15

export interface FolderDownloadShape {
  hasSubfolders: boolean
  fileCount: number
}

/** True when this folder should be delivered as individual files. */
export function shouldDownloadAsFiles(shape: FolderDownloadShape): boolean {
  if (shape.hasSubfolders) return false
  if (shape.fileCount <= 0) return false
  return shape.fileCount <= DIRECT_DOWNLOAD_MAX_FILES
}
