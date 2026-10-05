/**
 * 7.18.0: the cover of a document is the TOP of its first page.
 *
 * A PDF, a Word file or a plain-text note has no frame to grab, and the
 * first version of 7.18.0 drew the kind's glyph in the card instead. Dragos
 * asked for the top of page one: in practically every brief, contract or
 * script the title sits there, and a card that shows it tells you what the
 * document is without opening it. The image is the card's own aspect
 * (16:9, `DOC_THUMB_WIDTH` × `DOC_THUMB_HEIGHT`), the page scaled to the
 * full width and cut at the bottom — so a portrait A4 shows its top third
 * and a landscape slide shows all of itself. The card paints it with
 * `object-contain`, so a cover of exactly that aspect fills the box.
 *
 * This module runs in the WORKER only (regenerate-thumbnail job). It needs
 * `@napi-rs/canvas`, a native module, and pdf.js's Node build, which picks
 * that canvas up by itself (`require("@napi-rs/canvas")` inside
 * legacy/build/pdf.mjs). Nothing under src/app may import it: webpack would
 * try to bundle the native binding and pdf.js's worker into the server
 * bundle. The web routes only enqueue the job.
 *
 *   - PDF:  pdf.js renders page 1 into a canvas of the cover's size; the
 *           viewport is scaled to the cover's width and the canvas clips
 *           whatever falls below. `standardFontDataUrl` points at the
 *           fonts pdf.js ships, so a PDF without embedded fonts still has
 *           glyphs; `useSystemFonts: false` because the Debian runner has
 *           only DejaVu and pdf.js would pick odd fallbacks.
 *   - .docx: mammoth turns it into HTML; the block elements are read back
 *           as paragraphs with a heading level, and drawn like a page.
 *   - .txt:  the first lines, drawn like a page.
 *
 * Text pages are drawn with Liberation Sans, the metric-compatible Arial
 * that ships INSIDE pdfjs-dist (standard_fonts/), registered with the
 * canvas on first use — the worker image has no Arial and fontconfig's
 * default would differ between a Mac dev box and the Debian container.
 */
import fs from 'fs/promises'
import path from 'path'
import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import { documentKind, type DocumentKind } from './media-kind'

export const DOC_THUMB_WIDTH = 1280
export const DOC_THUMB_HEIGHT = 720
export const DOC_THUMB_JPEG_QUALITY = 84

/** How much of a text file is worth reading for a cover (bytes). */
const TEXT_READ_BYTES = 16 * 1024

const FONT_FAMILY = 'FC Document Sans'

type NapiCanvas = typeof import('@napi-rs/canvas')

/**
 * Resolve a package from the APP ROOT, not from this file. The worker runs
 * this module through tsx — as CommonJS in `npm run worker`, as ESM through
 * worker.mjs — so neither `require` nor `import.meta.url` is reliably
 * there. The process always starts in the app root (WORKDIR /app in the
 * image, the repo in dev), which is where node_modules is.
 */
const appRequire = createRequire(path.join(process.cwd(), 'package.json'))

function pdfjsDistDir(): string {
  return path.dirname(appRequire.resolve('pdfjs-dist/package.json'))
}

let canvasModule: NapiCanvas | null = null
let fontsRegistered = false

function loadCanvas(): NapiCanvas {
  if (!canvasModule) {
    canvasModule = appRequire('@napi-rs/canvas') as NapiCanvas
  }
  if (!fontsRegistered) {
    const fontsDir = path.join(pdfjsDistDir(), 'standard_fonts')
    canvasModule.GlobalFonts.registerFromPath(
      path.join(fontsDir, 'LiberationSans-Regular.ttf'),
      FONT_FAMILY,
    )
    canvasModule.GlobalFonts.registerFromPath(
      path.join(fontsDir, 'LiberationSans-Bold.ttf'),
      FONT_FAMILY,
    )
    fontsRegistered = true
  }
  return canvasModule
}

/** One block of a text-like document, with how loud it should be drawn. */
export interface TextBlock {
  text: string
  /** 0 = body, 1..3 = heading levels (1 is the biggest). */
  level: 0 | 1 | 2 | 3
}

/**
 * Render a document's cover and return it as JPEG bytes.
 *
 * @param filePath  the original, on local disk (the job downloads it first
 *                  when the storage is a bucket)
 * @param filename  the ORIGINAL file name — the kind is decided by extension
 */
export async function renderDocumentThumbnail(filePath: string, filename: string): Promise<Buffer> {
  const kind: DocumentKind = documentKind(filename)
  switch (kind) {
    case 'pdf':
      return renderPdfCover(filePath)
    case 'word':
      return renderTextCover(await wordBlocks(filePath))
    case 'text':
    default:
      return renderTextCover(await textBlocks(filePath))
  }
}

// ─── PDF ────────────────────────────────────────────────────────────────────

async function renderPdfCover(filePath: string): Promise<Buffer> {
  const { createCanvas } = loadCanvas()
  const distDir = pdfjsDistDir()
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // The fake worker loads the worker script with a dynamic import; in Node
  // it has to be told where that script is.
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    path.join(distDir, 'legacy/build/pdf.worker.mjs'),
  ).href

  // A file:// URL is read through pdf.js's Node stream with range requests,
  // so a 400 MB deck is not pulled into memory to paint its first page.
  const task = pdfjs.getDocument({
    url: pathToFileURL(filePath).href,
    standardFontDataUrl: path.join(distDir, 'standard_fonts') + path.sep,
    cMapUrl: path.join(distDir, 'cmaps') + path.sep,
    cMapPacked: true,
    useSystemFonts: false,
    disableAutoFetch: true,
  })
  try {
    const doc = await task.promise
    const page = await doc.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const scale = DOC_THUMB_WIDTH / base.width
    const viewport = page.getViewport({ scale })

    const canvas = createCanvas(DOC_THUMB_WIDTH, DOC_THUMB_HEIGHT)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, DOC_THUMB_WIDTH, DOC_THUMB_HEIGHT)
    // A landscape page shorter than the cover is centred vertically on
    // white instead of leaving a white band only at the bottom.
    const yOffset = viewport.height < DOC_THUMB_HEIGHT ? (DOC_THUMB_HEIGHT - viewport.height) / 2 : 0
    // pdf.js 6 wants the canvas itself (it reads the context off it); the
    // napi canvas has the same surface, hence the cast.
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
      transform: yOffset > 0 ? [1, 0, 0, 1, 0, yOffset] : undefined,
    }).promise
    page.cleanup()
    return canvas.toBuffer('image/jpeg', DOC_THUMB_JPEG_QUALITY)
  } finally {
    await task.destroy().catch(() => {})
  }
}

// ─── Text-like documents ────────────────────────────────────────────────────

async function textBlocks(filePath: string): Promise<TextBlock[]> {
  const handle = await fs.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(TEXT_READ_BYTES)
    const { bytesRead } = await handle.read(buf, 0, TEXT_READ_BYTES, 0)
    let text = buf.subarray(0, bytesRead).toString('utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return textToBlocks(text)
  } finally {
    await handle.close()
  }
}

/** Plain text: one block per line (blank lines kept as spacing). */
export function textToBlocks(text: string): TextBlock[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => ({ text: line.replace(/\t/g, '    ').replace(/\s+$/, ''), level: 0 as const }))
}

async function wordBlocks(filePath: string): Promise<TextBlock[]> {
  const mammoth = await import('mammoth')
  const { value: html } = await mammoth.convertToHtml({ path: filePath })
  return htmlToBlocks(html)
}

/**
 * Read mammoth's HTML back as blocks. Mammoth emits a flat, predictable
 * document — `<h1>`…`<h6>`, `<p>`, `<li>`, `<table>` — so a tag scan is
 * enough; no DOM is available in the worker and none is needed. Inline
 * tags are stripped, entities decoded, list items get a bullet.
 */
export function htmlToBlocks(html: string): TextBlock[] {
  const blocks: TextBlock[] = []
  const re = /<(h[1-6]|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase()
    const inner = decodeEntities(m[2].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''))
      .replace(/\s+/g, ' ')
      .trim()
    let level: TextBlock['level'] = 0
    if (tag === 'h1') level = 1
    else if (tag === 'h2') level = 2
    else if (/^h[3-6]$/.test(tag)) level = 3
    blocks.push({ text: tag === 'li' ? `• ${inner}` : inner, level })
    if (blocks.length > 80) break
  }
  return blocks
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
}

/** Type sizes of a text page, chosen so an A4-ish page reads at card size. */
const PAGE_MARGIN_X = 112
const PAGE_MARGIN_TOP = 96
const BODY_PX = 26
const BODY_LINE = 38
const HEADING_PX: Record<1 | 2 | 3, number> = { 1: 46, 2: 36, 3: 30 }
const PARAGRAPH_GAP = 14

function renderTextCover(blocks: TextBlock[]): Buffer {
  const { createCanvas } = loadCanvas()
  const canvas = createCanvas(DOC_THUMB_WIDTH, DOC_THUMB_HEIGHT)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, DOC_THUMB_WIDTH, DOC_THUMB_HEIGHT)
  ctx.fillStyle = '#1f2328'
  ctx.textBaseline = 'alphabetic'

  const maxWidth = DOC_THUMB_WIDTH - PAGE_MARGIN_X * 2
  let y = PAGE_MARGIN_TOP
  // Leading blank lines carry nothing; the title should sit at the top.
  let started = false

  for (const block of blocks) {
    if (y > DOC_THUMB_HEIGHT) break
    if (block.text.trim() === '') {
      if (started) y += BODY_LINE * 0.6
      continue
    }
    started = true
    const px = block.level === 0 ? BODY_PX : HEADING_PX[block.level]
    const line = block.level === 0 ? BODY_LINE : Math.round(px * 1.3)
    ctx.font = `${block.level === 0 ? '' : 'bold '}${px}px "${FONT_FAMILY}"`
    for (const wrapped of wrapLine(ctx as unknown as CanvasRenderingContext2D, block.text, maxWidth)) {
      y += line
      if (y > DOC_THUMB_HEIGHT + line) break
      ctx.fillText(wrapped, PAGE_MARGIN_X, y - Math.round(line * 0.28))
    }
    if (block.level > 0) y += PARAGRAPH_GAP
  }
  return canvas.toBuffer('image/jpeg', DOC_THUMB_JPEG_QUALITY)
}

/** Greedy word wrap by measured width; a single over-long word is cut. */
export function wrapLine(
  ctx: Pick<CanvasRenderingContext2D, 'measureText'>,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate
      continue
    }
    if (current) lines.push(current)
    if (ctx.measureText(word).width <= maxWidth) {
      current = word
      continue
    }
    // Break a word that alone is wider than the page.
    let piece = ''
    for (const ch of word) {
      if (ctx.measureText(piece + ch).width > maxWidth && piece) {
        lines.push(piece)
        piece = ''
      }
      piece += ch
    }
    current = piece
  }
  if (current) lines.push(current)
  return lines
}
