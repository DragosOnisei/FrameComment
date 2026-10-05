#!/usr/bin/env node
/**
 * 7.18.0: put pdf.js's worker where the browser can fetch it.
 *
 * DocumentViewer renders PDFs with pdfjs-dist, which parses the file in a
 * Web Worker it loads by URL (`GlobalWorkerOptions.workerSrc`). Bundling the
 * worker through webpack is fragile across Next versions, so the built file
 * is copied verbatim from node_modules into public/vendor/ and served as a
 * static asset at /vendor/pdf.worker.min.mjs. Runs as `predev` and
 * `prebuild` (npm runs pre-scripts automatically), so a fresh checkout and
 * the Docker builder stage both have it before Next starts; the copy is
 * gitignored because it is derived from the installed package version.
 */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs')
const dest = join(root, 'public', 'vendor', 'pdf.worker.min.mjs')

if (!existsSync(src)) {
  console.error(`[copy-pdf-worker] missing ${src} — is pdfjs-dist installed?`)
  process.exit(1)
}
mkdirSync(dirname(dest), { recursive: true })
copyFileSync(src, dest)
console.log(`[copy-pdf-worker] ${dest}`)
