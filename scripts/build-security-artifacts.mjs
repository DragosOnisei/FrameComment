#!/usr/bin/env node
/**
 * 6.18.0 — the two artefacts the security scan cannot produce at runtime.
 *
 * Both of these questions can only be answered honestly at BUILD time, and the
 * scan says SKIPPED rather than PASS when the file is absent — a check that
 * could not run must never look like a check that succeeded.
 *
 *   .integrity-manifest.json
 *     SHA-256 of every shipped application file. At runtime the scan re-hashes
 *     them and compares. Inside a container nothing should ever differ: the
 *     image is immutable, so a changed file means someone has a shell in the
 *     running container. That is the only version of "file changes" that is
 *     meaningful here — Wordfence compares against wordpress.org because PHP
 *     source is editable in place, which ours is not.
 *
 *   .audit-report.json
 *     `npm audit` needs the registry and a lockfile, neither of which is
 *     guaranteed in a production container — and an image that phoned home to
 *     npm on every scan would be a worse idea than the check is worth. Running
 *     it here records what was true when the image was built, which is the
 *     honest claim: "these were the known vulnerabilities in this build".
 *
 * Run from the Dockerfile after `npm ci` and after `next build`.
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execSync } from 'child_process'

const root = process.cwd()

// What to hash.
//
// Must be exactly what the RUNNER stage of the Dockerfile copies, no more.
// The first version also hashed `scripts/`, which the builder has and the
// runner does not — so every production scan reported a dozen files as
// "missing" and raised a CRITICAL saying the running code was not the code we
// shipped. It was the manifest that was wrong, not the container, and a
// security report that cries wolf on its own bookkeeping is worse than one
// that omits the check.
//
// Deliberately not node_modules either: 800MB would take minutes to hash on
// every scan, and a modified dependency shows up in the audit report instead.
const ROOTS = ['src', 'prisma', 'public']
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'uploads', 'uploads-dev'])

function walk(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

function buildManifest() {
  const manifest = {}
  for (const r of ROOTS) {
    const abs = path.join(root, r)
    if (!fs.existsSync(abs)) continue
    for (const file of walk(abs)) {
      const rel = path.relative(root, file)
      manifest[rel] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    }
  }
  // Sorted so the file is reproducible and a diff between two builds is
  // readable rather than a reshuffle.
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)))
  fs.writeFileSync(
    path.join(root, '.integrity-manifest.json'),
    JSON.stringify(sorted, null, 0),
  )
  return Object.keys(sorted).length
}

function buildAuditReport() {
  try {
    // `npm audit` exits non-zero when it finds anything, which is the normal
    // case — so the exit code is ignored and only the JSON matters. The build
    // must not fail because a transitive dependency has a moderate advisory.
    const json = execSync('npm audit --json --legacy-peer-deps', {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    })
    fs.writeFileSync(path.join(root, '.audit-report.json'), json)
    return JSON.parse(json)?.metadata?.vulnerabilities ?? null
  } catch (error) {
    // Non-zero exit still writes to stdout; use it when it parses.
    const out = error?.stdout?.toString?.() || ''
    if (out.trim().startsWith('{')) {
      fs.writeFileSync(path.join(root, '.audit-report.json'), out)
      try {
        return JSON.parse(out)?.metadata?.vulnerabilities ?? null
      } catch {
        return null
      }
    }
    console.warn('[security-artifacts] npm audit unavailable; the scan will report this check as skipped')
    return null
  }
}

const fileCount = buildManifest()
console.log(`[security-artifacts] Hashed ${fileCount} files into .integrity-manifest.json`)

const vulns = buildAuditReport()
if (vulns) {
  console.log(
    `[security-artifacts] Audit recorded: ${vulns.critical || 0} critical, ${vulns.high || 0} high, ` +
    `${vulns.moderate || 0} moderate, ${vulns.low || 0} low`,
  )
}
