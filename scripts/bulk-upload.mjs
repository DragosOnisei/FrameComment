#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * 2.0.x+: bulk uploader for migrating large filesystem libraries
 * into FrameComment via the official TUS pipeline.
 *
 * Why this exists: dragging 2+ TB / 4000+ files into the browser
 * upload zone crashes Chrome because the browser has to enumerate
 * the entire tree at once. This Node.js CLI walks the source tree
 * one file at a time, creates the matching Folder records, then
 * uploads each video through TUS (with resume support).
 *
 * Usage:
 *   node scripts/bulk-upload.mjs \
 *     --base-url http://framecomment.local:3000 \
 *     --email admin@example.com \
 *     --password '...' \
 *     --source /Volumes/Windows/01_VDA \
 *     --project '01_VDA'
 *
 * State file (default: .bulk-upload-state.json next to source) tracks
 * which (relativePath) entries are done. Re-running with the same
 * --source + --project picks up where it left off; finished files
 * are skipped without touching the server.
 *
 * Resume of a half-uploaded file is handled by tus-js-client's
 * fingerprint store (~/.bulk-upload-tus-store/<key>.json). Even if
 * the network drops mid-fragment the next run continues from the
 * last acknowledged offset.
 *
 * Run with --dry-run first to see what it would do without hitting
 * the server.
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'
import * as tus from 'tus-js-client'

// ────────────────────────────────────────────────────────────────────
// Argument parsing
// ────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2))

// 2.0.x+: env vars take precedence if the flag isn't set, so the
// user can stash creds in their shell rc / a .env file / a CI
// secret rather than pasting them on every invocation (where they
// land in shell history + clipboard managers).
const baseUrl = args['base-url'] || process.env.FRAMECOMMENT_BASE_URL
const email = args.email || process.env.FRAMECOMMENT_EMAIL
const password = args.password || process.env.FRAMECOMMENT_PASSWORD

if (args.help || !baseUrl || !email || !password || !args.source || !args.project) {
  console.error(`
bulk-upload.mjs — FrameComment migration uploader

Required (flag OR env var):
  --base-url <url>     | FRAMECOMMENT_BASE_URL    Server base URL
  --email <email>      | FRAMECOMMENT_EMAIL       Admin email
  --password <pwd>     | FRAMECOMMENT_PASSWORD    Admin password
  --source <path>                                 Local folder to ingest
  --project <name>                                Target project name
                                                  (auto-created if missing)

Optional:
  --state <path>       State file (default: <source>/.bulk-upload-state.json)
  --concurrency <n>    Parallel uploads (default: 2)
  --dry-run            Walk + report only; no API calls
  --extensions <list>  Comma list (default: mp4,mov,m4v,avi,mkv,webm,
                       jpg,jpeg,png,gif,webp)
  --no-skip-existing   Force re-upload (default skips files already done)
  --reset              Delete the state file + errors log BEFORE running.
                       Useful for repeat test runs against a fresh project.
                       Implies --no-skip-existing.
  --suffix-existing    When the target project already exists on the
                       server, auto-append _2, _3, ... to the requested
                       name and create a NEW project instead of reusing
                       the cached one. Pairs nicely with --reset for
                       quick smoke tests.
  --verbose            Log every API call + folder creation

Examples:

  # One-off with all flags inline
  node scripts/bulk-upload.mjs \\
    --base-url http://192.168.100.20:4321 \\
    --email admin@example.com --password 'secret' \\
    --source /Volumes/Windows/04_DFFR --project '04_DFFR' --dry-run

  # Stash creds in env, run multiple projects without re-typing them
  export FRAMECOMMENT_BASE_URL=http://192.168.100.20:4321
  export FRAMECOMMENT_EMAIL=admin@example.com
  read -s FRAMECOMMENT_PASSWORD; export FRAMECOMMENT_PASSWORD
  node scripts/bulk-upload.mjs --source /Volumes/Windows/04_DFFR --project '04_DFFR'
`)
  process.exit(args.help ? 0 : 1)
}

const config = {
  baseUrl: baseUrl.replace(/\/$/, ''),
  email,
  password,
  source: path.resolve(args.source),
  projectName: args.project,
  stateFile:
    args.state ||
    path.join(path.resolve(args.source), '.bulk-upload-state.json'),
  errorLogFile:
    args['error-log'] ||
    path.join(path.resolve(args.source), '.bulk-upload-errors.log'),
  concurrency: Math.max(1, parseInt(args.concurrency || '2', 10)),
  dryRun: !!args['dry-run'],
  extensions: (args.extensions ||
    'mp4,mov,m4v,avi,mkv,webm,jpg,jpeg,png,gif,webp')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\./, '')),
  skipExisting: args['no-skip-existing'] || args.reset ? false : true,
  reset: !!args.reset,
  suffixExisting: !!args['suffix-existing'],
  verbose: !!args.verbose,
}

// 2.0.5+: --reset wipes the per-source bookkeeping BEFORE we load it,
// so loadState() below starts from a clean slate. This avoids the
// "6 already uploaded, 0 to go" trap when you're re-testing against a
// fresh project on the same source folder. Errors log is wiped too so
// the new run's errors aren't mixed with stale ones.
if (config.reset && !config.dryRun) {
  for (const p of [config.stateFile, config.errorLogFile]) {
    try {
      fs.unlinkSync(p)
      console.log(`✓ Reset: removed ${p}`)
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`! Reset: could not remove ${p}: ${err.message}`)
      }
    }
  }
}

if (!fs.existsSync(config.source) || !fs.statSync(config.source).isDirectory()) {
  console.error(`✗ Source is not a directory: ${config.source}`)
  process.exit(2)
}

const log = {
  info: (...a) => console.log('•', ...a),
  ok: (...a) => console.log('✓', ...a),
  warn: (...a) => console.warn('⚠', ...a),
  err: (...a) => console.error('✗', ...a),
  verbose: (...a) => config.verbose && console.log('  ·', ...a),
}

// 2.0.x+: error log that survives the run so the user can see
// after the fact which files failed and why. Append-mode so
// successive runs accumulate without clobbering.
function logError(relPath, err) {
  try {
    const line = `[${new Date().toISOString()}] ${relPath} — ${err?.message || err}\n`
    fs.appendFileSync(config.errorLogFile, line)
  } catch {
    // best-effort — if even the error log fails we still see it
    // on stderr through the call site.
  }
}

// ────────────────────────────────────────────────────────────────────
// State persistence — survives kill -9
// ────────────────────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(config.stateFile)) {
      const raw = fs.readFileSync(config.stateFile, 'utf8')
      return JSON.parse(raw)
    }
  } catch (err) {
    log.warn(`State file unreadable, starting fresh: ${err.message}`)
  }
  return {
    completed: {}, // relativePath → { videoId, completedAt }
    folders: {}, // relativeFolderPath → folderId
    projectId: null,
  }
}

function saveState(state) {
  try {
    const tmp = config.stateFile + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
    fs.renameSync(tmp, config.stateFile)
  } catch (err) {
    log.warn(`Could not persist state: ${err.message}`)
  }
}

const state = loadState()

// ────────────────────────────────────────────────────────────────────
// Auth + API helpers
// ────────────────────────────────────────────────────────────────────

let accessToken = null
let tokenExpiresAt = 0

async function login() {
  log.verbose(`POST ${config.baseUrl}/api/auth/login`)
  // 2.2.5+: wrap the login fetch in the same retry helper used by
  // apiCall. Token-refresh hops happen every ~14 minutes during a
  // long catalog upload — if even one of them hits a flaky moment
  // the whole script used to crash. Retrying transient network
  // errors lets the upload survive momentary server hiccups.
  const res = await fetchWithRetry(
    'POST /api/auth/login',
    `${config.baseUrl}/api/auth/login`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: config.email, password: config.password }),
    },
  )
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Login failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  if (!data?.tokens?.accessToken) {
    throw new Error(`Login response missing accessToken`)
  }
  accessToken = data.tokens.accessToken
  // accessExpiresAt is in milliseconds since epoch (JWT TTL ≈ 15 min)
  tokenExpiresAt = data.tokens.accessExpiresAt || Date.now() + 14 * 60 * 1000
  log.ok(`Logged in as ${data.user.email} (role: ${data.user.role})`)
}

async function ensureValidToken() {
  // Refresh 60s before expiry so in-flight uploads aren't interrupted.
  if (!accessToken || Date.now() > tokenExpiresAt - 60_000) {
    await login()
  }
}

// 2.2.5+ resilience helper: detect transient network errors so the
// JSON-API call layer can survive a server restart / WiFi blip /
// router reboot mid-upload without killing the whole 30+ hour
// transfer. `TypeError: fetch failed` from Node's undici has the
// real cause hanging off `err.cause.code` (ECONNRESET, ECONNREFUSED,
// EAI_AGAIN, ETIMEDOUT, ENOTFOUND, EPIPE, UND_ERR_SOCKET, etc).
function isTransientNetworkError(err) {
  if (!err) return false
  const name = err.name || ''
  const msg = err.message || ''
  if (name === 'AbortError') return true
  if (/fetch failed/i.test(msg)) return true
  if (/socket hang up|connect timeout|connect ETIMEDOUT/i.test(msg)) return true
  const code =
    (err.cause && (err.cause.code || err.cause.errno)) ||
    err.code ||
    err.errno ||
    ''
  if (typeof code === 'string') {
    return [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ECONNABORTED',
      'EAI_AGAIN',
      'ENOTFOUND',
      'EPIPE',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'UND_ERR_SOCKET',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
    ].includes(code)
  }
  return false
}

// Same backoff ladder TUS uses internally — keeps the API layer in
// step with the resumable-upload retry behaviour the user already
// experiences for the actual file transfer.
const API_RETRY_DELAYS_MS = [1000, 3000, 5000, 10000, 30000, 60000]

async function fetchWithRetry(label, url, init) {
  let lastErr
  for (let attempt = 0; attempt <= API_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fetch(url, init)
    } catch (err) {
      lastErr = err
      if (!isTransientNetworkError(err) || attempt === API_RETRY_DELAYS_MS.length) {
        throw err
      }
      const delay = API_RETRY_DELAYS_MS[attempt]
      const code = (err.cause && err.cause.code) || err.code || ''
      log.warn(
        `${label}: ${err.message}${code ? ` (${code})` : ''} — retrying in ${delay / 1000}s ` +
          `(attempt ${attempt + 1}/${API_RETRY_DELAYS_MS.length})`,
      )
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
}

async function apiCall(method, pathname, body) {
  await ensureValidToken()
  const url = `${config.baseUrl}${pathname}`
  log.verbose(`${method} ${pathname}`)
  // 2.2.5+: wrap both the initial call AND the 401-refresh retry in
  // `fetchWithRetry` so transient network errors during EITHER hop
  // survive automatically. Pre-2.2.5 a single "fetch failed" here
  // (server restarted while creating a video row, brief WiFi drop,
  // etc.) killed the whole run — even though the script's state
  // file would let you resume, that's still a manual step every
  // few hours on a multi-day catalog upload.
  const res = await fetchWithRetry(`${method} ${pathname}`, url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401) {
    // Force a relogin and retry once.
    log.verbose('401 — refreshing token')
    accessToken = null
    await ensureValidToken()
    const retryRes = await fetchWithRetry(`${method} ${pathname} (auth retry)`, url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!retryRes.ok) {
      const text = await retryRes.text().catch(() => '')
      throw new Error(`${method} ${pathname} retry failed: HTTP ${retryRes.status} — ${text.slice(0, 200)}`)
    }
    return retryRes.json()
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${method} ${pathname} failed: HTTP ${res.status} — ${text.slice(0, 200)}`)
  }
  if (res.status === 204) return null
  return res.json()
}

// ────────────────────────────────────────────────────────────────────
// Project + folder helpers
// ────────────────────────────────────────────────────────────────────

async function findOrCreateProject(name) {
  if (state.projectId) {
    log.ok(`Using cached project id ${state.projectId} for "${name}"`)
    return state.projectId
  }
  const projects = await apiCall('GET', '/api/projects')
  const list = Array.isArray(projects) ? projects : projects?.projects || []

  // 2.0.5+: --suffix-existing turns "match by name" upside down.
  // Instead of reusing the existing project, we find the next free
  // suffix (_2, _3, ...) and CREATE a new project. Useful for repeat
  // test runs against a fresh project without manual rename.
  if (config.suffixExisting) {
    const existingTitles = new Set(list.map((p) => p.title))
    if (existingTitles.has(name)) {
      let n = 2
      while (existingTitles.has(`${name}_${n}`)) n++
      const suffixed = `${name}_${n}`
      log.info(`Project "${name}" exists — using "${suffixed}" instead`)
      name = suffixed
      config.projectName = suffixed
    }
  } else {
    const match = list.find((p) => p.title === name)
    if (match) {
      log.ok(`Found existing project "${name}" (${match.id})`)
      state.projectId = match.id
      saveState(state)
      return match.id
    }
  }
  if (config.dryRun) {
    log.info(`[dry-run] would create project "${name}"`)
    return 'dry-run-project-id'
  }
  const created = await apiCall('POST', '/api/projects', {
    title: name,
    authMode: 'NONE',
  })
  const newId = created?.project?.id || created?.id
  if (!newId) throw new Error(`Project creation response missing id: ${JSON.stringify(created).slice(0, 200)}`)
  log.ok(`Created new project "${name}" (${newId})`)
  state.projectId = newId
  saveState(state)
  return newId
}

/**
 * Ensure every folder along `relativeFolderPath` exists in the
 * project, returning the deepest folder's id (or null for the
 * project root). Caches results in state.folders.
 */
async function ensureFolderPath(projectId, relativeFolderPath) {
  if (!relativeFolderPath || relativeFolderPath === '.' || relativeFolderPath === '') {
    return null
  }
  const parts = relativeFolderPath.split(path.sep).filter(Boolean)
  let parentId = null
  let acc = ''
  for (const seg of parts) {
    acc = acc ? `${acc}/${seg}` : seg
    if (state.folders[acc]) {
      parentId = state.folders[acc]
      continue
    }
    // Server-side list — match by name + parent + project so we don't
    // double-create if the script previously crashed before saveState.
    const existing = await apiCall(
      'GET',
      `/api/folders?projectId=${encodeURIComponent(projectId)}&parentFolderId=${encodeURIComponent(parentId || 'root')}`,
    )
    const list = Array.isArray(existing) ? existing : existing?.folders || []
    const match = list.find((f) => f.name === seg)
    if (match) {
      parentId = match.id
      state.folders[acc] = parentId
      saveState(state)
      continue
    }
    if (config.dryRun) {
      log.verbose(`[dry-run] would create folder "${seg}" under ${parentId || '(root)'}`)
      parentId = `dry-${acc}`
      state.folders[acc] = parentId
      continue
    }
    const created = await apiCall('POST', '/api/folders', {
      projectId,
      parentFolderId: parentId,
      name: seg,
    })
    const newId = created?.folder?.id || created?.id
    if (!newId) throw new Error(`Folder creation response missing id: ${JSON.stringify(created).slice(0, 200)}`)
    parentId = newId
    state.folders[acc] = parentId
    saveState(state)
    log.verbose(`Created folder "${seg}" → ${parentId}`)
  }
  return parentId
}

// ────────────────────────────────────────────────────────────────────
// File walk
// ────────────────────────────────────────────────────────────────────

function* walkFiles(rootDir) {
  const stack = [rootDir]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      log.warn(`Cannot read ${dir}: ${err.message}`)
      continue
    }
    for (const entry of entries) {
      // Skip macOS junk and hidden files.
      if (entry.name.startsWith('.') || entry.name === 'Thumbs.db') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).slice(1).toLowerCase()
        if (config.extensions.length === 0 || config.extensions.includes(ext)) {
          yield full
        }
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// TUS upload of a single file
// ────────────────────────────────────────────────────────────────────

const TUS_RETRY_DELAYS_MS = [0, 1000, 3000, 5000, 10000, 30000, 60000]

function getChunkSizeBytes(fileSize) {
  // Mirror the in-app heuristic: ~10 MB for desktop. Smaller chunks
  // make recovery cheaper after a dropped connection; larger chunks
  // reduce per-chunk HTTP overhead. 10 MB is the sweet spot.
  return Math.min(10 * 1024 * 1024, Math.max(1024 * 1024, fileSize))
}

const MIME_BY_EXT = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
}

function guessMime(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase()
  return MIME_BY_EXT[ext] || 'application/octet-stream'
}

// 2.0.x+: per-upload progress state surfaced by the dashboard.
const activeUploads = new Map() // relativeKey → { filename, uploaded, total }

async function uploadFile(filePath, projectId, folderId, relativeKey) {
  const stat = fs.statSync(filePath)
  const filename = path.basename(filePath)
  const mimeType = guessMime(filename)

  if (config.dryRun) {
    log.info(`[dry-run] would upload "${filename}" (${formatBytes(stat.size)}) → folderId=${folderId || '(root)'}`)
    return
  }

  // 1) Create the Video DB row
  const baseName = filename.replace(/\.[^./]+$/, '')
  const createBody = {
    projectId,
    folderId: folderId || undefined,
    versionLabel: 'v1',
    originalFileName: filename,
    originalFileSize: stat.size,
    mimeType,
    name: baseName,
  }
  const created = await apiCall('POST', '/api/videos', createBody)
  const videoId = created?.videoId || created?.video?.id
  if (!videoId) throw new Error(`Video creation response missing videoId: ${JSON.stringify(created).slice(0, 200)}`)

  activeUploads.set(relativeKey, { filename, uploaded: 0, total: stat.size })

  // 2) TUS upload
  try {
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath)
      const upload = new tus.Upload(stream, {
        uploadSize: stat.size,
        endpoint: `${config.baseUrl}/api/uploads`,
        retryDelays: TUS_RETRY_DELAYS_MS,
        chunkSize: getChunkSizeBytes(stat.size),
        storeFingerprintForResuming: true,
        removeFingerprintOnSuccess: true,
        metadata: {
          filename,
          filetype: mimeType,
          videoId,
        },
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        onBeforeRequest: async (req) => {
          await ensureValidToken()
          try {
            req.setHeader('Authorization', `Bearer ${accessToken}`)
          } catch {}
        },
        onProgress: (uploaded, total) => {
          const entry = activeUploads.get(relativeKey)
          if (entry) {
            entry.uploaded = uploaded
            entry.total = total
          }
        },
        onSuccess: () => resolve(),
        onError: (err) => reject(err),
      })
      upload.start()
    })
  } finally {
    activeUploads.delete(relativeKey)
  }

  // 3) Mark done
  state.completed[relativeKey] = { videoId, completedAt: Date.now(), size: stat.size }
  saveState(state)
}

// ────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────

function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (!next || next.startsWith('--')) {
        out[key] = true
      } else {
        out[key] = next
        i++
      }
    }
  }
  return out
}

// 2.0.x+: live dashboard. Re-renders every ~500ms while uploads run.
//
// Layout:
//   ━━━━━━━━━━ Overall ━━━━━━━━━━
//   1234 / 4227 files  •  421 GB / 2.8 TB (15%)  •  87 MB/s  •  ETA 4h 32m
//   ━━━━━━━━━━ Active ━━━━━━━━━━━
//   ⬆ 045_Clip_A.mp4   [████████░░░░░░░░░░░░]  42%   183 MB / 437 MB
//   ⬆ 045_Clip_B.mov   [██████████████░░░░░░]  71%   1.1 GB / 1.5 GB
//   (last error: see <error-log-path>)
//
// We track the line count we rendered so the next paint can clear
// exactly those lines, no terminal scrollback pollution.
const dash = {
  totalFiles: 0,
  totalBytes: 0,
  doneFiles: 0,
  doneBytes: 0,
  errorCount: 0,
  lastError: null,
  startedAt: 0,
  renderedLines: 0,
}

function renderBar(pct, width = 20) {
  const filled = Math.round((pct / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function renderDashboard() {
  // Clear what we wrote last time.
  if (dash.renderedLines > 0) {
    process.stdout.write(`\x1b[${dash.renderedLines}A`)
    process.stdout.write('\x1b[0J')
  }
  const lines = []
  const elapsedSec = Math.max(1, (Date.now() - dash.startedAt) / 1000)
  const rate = dash.doneBytes / elapsedSec
  const remainingBytes = Math.max(0, dash.totalBytes - dash.doneBytes)
  const eta = rate > 0 ? remainingBytes / rate : Infinity
  const bytesPct = dash.totalBytes > 0
    ? Math.round((dash.doneBytes / dash.totalBytes) * 100)
    : 0
  lines.push('━━━━━━━━━━━━━ Overall ━━━━━━━━━━━━━')
  lines.push(
    `  ${dash.doneFiles}/${dash.totalFiles} files  •  ${formatBytes(dash.doneBytes)} / ${formatBytes(dash.totalBytes)} (${bytesPct}%)  •  ${formatBytes(rate)}/s  •  ETA ${formatDuration(eta)}`,
  )
  if (activeUploads.size > 0) {
    lines.push('━━━━━━━━━━━━━ Active  ━━━━━━━━━━━━━')
    for (const [, entry] of activeUploads) {
      const pct = entry.total > 0 ? Math.round((entry.uploaded / entry.total) * 100) : 0
      const bar = renderBar(pct)
      const truncName = entry.filename.length > 32
        ? entry.filename.slice(0, 29) + '…'
        : entry.filename.padEnd(32, ' ')
      lines.push(
        `  ⬆ ${truncName} [${bar}] ${String(pct).padStart(3)}%   ${formatBytes(entry.uploaded)} / ${formatBytes(entry.total)}`,
      )
    }
  }
  if (dash.errorCount > 0) {
    lines.push(`  ⚠ ${dash.errorCount} error(s) so far — see ${config.errorLogFile}`)
  }
  for (const line of lines) process.stdout.write(line + '\n')
  dash.renderedLines = lines.length
}

// Strips the dashboard so subsequent regular console.log lines
// (e.g. final summary) print in a normal scrollable way.
function teardownDashboard() {
  if (dash.renderedLines > 0) {
    process.stdout.write(`\x1b[${dash.renderedLines}A`)
    process.stdout.write('\x1b[0J')
    dash.renderedLines = 0
  }
}

async function main() {
  log.info(`Source:      ${config.source}`)
  log.info(`Project:     ${config.projectName}`)
  log.info(`Base URL:    ${config.baseUrl}`)
  log.info(`State file:  ${config.stateFile}`)
  log.info(`Errors:      ${config.errorLogFile}`)
  log.info(`Concurrency: ${config.concurrency}`)
  log.info(`Dry run:     ${config.dryRun}`)
  log.info(`Extensions:  ${config.extensions.join(', ')}`)
  log.info('')

  if (!config.dryRun) await login()

  const allFiles = []
  for (const f of walkFiles(config.source)) {
    allFiles.push(f)
  }
  const totalSize = allFiles.reduce((sum, f) => sum + fs.statSync(f).size, 0)
  log.info(`Found ${allFiles.length} files, total ${formatBytes(totalSize)}`)

  const remaining = allFiles.filter((f) => {
    const rel = path.relative(config.source, f)
    return !(config.skipExisting && state.completed[rel])
  })
  const remainingBytes = remaining.reduce((sum, f) => sum + fs.statSync(f).size, 0)
  log.info(
    `${allFiles.length - remaining.length} already uploaded, ${remaining.length} to go (${formatBytes(remainingBytes)})`,
  )
  log.info('')

  const projectId = await findOrCreateProject(config.projectName)

  const byFolder = new Map()
  for (const f of remaining) {
    const rel = path.relative(config.source, f)
    const folderRel = path.dirname(rel)
    if (!byFolder.has(folderRel)) byFolder.set(folderRel, [])
    byFolder.get(folderRel).push(f)
  }

  dash.totalFiles = remaining.length
  dash.totalBytes = remainingBytes
  dash.startedAt = Date.now()

  // Start the dashboard refresh loop.
  const refreshHandle = config.dryRun ? null : setInterval(renderDashboard, 500)

  for (const [folderRel, files] of byFolder) {
    const folderId = await ensureFolderPath(projectId, folderRel === '.' ? '' : folderRel)
    if (config.verbose) {
      log.info(`Folder: ${folderRel === '.' ? '(project root)' : folderRel} → ${folderId || '(root)'}`)
    }

    let cursor = 0
    const inflight = new Set()
    const launch = async (file) => {
      const rel = path.relative(config.source, file)
      try {
        await uploadFile(file, projectId, folderId, rel)
        dash.doneFiles += 1
        dash.doneBytes += fs.statSync(file).size
      } catch (err) {
        dash.errorCount += 1
        dash.lastError = `${rel}: ${err.message}`
        logError(rel, err)
      }
    }
    while (cursor < files.length) {
      while (inflight.size < config.concurrency && cursor < files.length) {
        const f = files[cursor++]
        const p = launch(f).finally(() => inflight.delete(p))
        inflight.add(p)
      }
      if (inflight.size > 0) await Promise.race(inflight)
    }
    await Promise.all(inflight)
  }

  if (refreshHandle) clearInterval(refreshHandle)
  teardownDashboard()

  log.info('')
  log.ok(
    `Done. ${dash.doneFiles}/${dash.totalFiles} files in ${formatDuration((Date.now() - dash.startedAt) / 1000)}`,
  )
  if (dash.errorCount > 0) {
    log.warn(`${dash.errorCount} file(s) failed — see ${config.errorLogFile}`)
  }
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '?'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

main().catch((err) => {
  log.err(`Fatal: ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
