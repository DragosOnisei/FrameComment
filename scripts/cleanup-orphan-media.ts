/**
 * cleanup-orphan-media.ts (4.1.4+)
 *
 * Reclaims storage left behind by the pre-4.1.4 delete bug, where
 * permanently deleting a VIDEO (Empty Trash / per-item permanent delete)
 * removed the original + some preview tiers but LEFT the HLS segment
 * folder, the 480p tier and clean previews on disk — orphaned GBs with no
 * DB row pointing at them.
 *
 * It compares what's on disk under STORAGE_ROOT/projects against the
 * database and removes only things the DB no longer references:
 *
 *   1. projects/{id}            — where no Project row (any state) exists
 *   2. projects/{id}/videos/{videoId}/ — where no Video row exists
 *   3. projects/{id}/videos/original-*  — files not referenced by any
 *                                          Video.originalStoragePath
 *
 * SAFE BY DEFAULT: dry-run unless you pass --confirm. It never touches
 * anything outside STORAGE_ROOT/projects, and it treats soft-deleted rows
 * (still in Trash) as "keep" — those are cleaned by the retention cron.
 *
 * Run:
 *   npx tsx scripts/cleanup-orphan-media.ts               # dry-run (report only)
 *   npx tsx scripts/cleanup-orphan-media.ts --confirm     # actually delete
 *
 * On the server, run it inside the app container with STORAGE_ROOT +
 * DATABASE_URL already set in the environment.
 */

/* eslint-disable no-console */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const CONFIRM = process.argv.includes('--confirm')
const STORAGE_ROOT = path.resolve(process.env.STORAGE_ROOT || './uploads-dev')
const PROJECTS_DIR = path.join(STORAGE_ROOT, 'projects')

function dirSize(target: string): number {
  let total = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(target, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const full = path.join(target, e.name)
    if (e.isDirectory()) total += dirSize(full)
    else if (e.isFile()) {
      try {
        total += fs.statSync(full).size
      } catch {
        /* ignore */
      }
    }
  }
  return total
}

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

// Guard: refuse to remove anything that isn't a real path under PROJECTS_DIR.
function assertInsideProjects(target: string): void {
  const real = fs.realpathSync(target)
  const root = fs.realpathSync(PROJECTS_DIR)
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error(`Refusing to touch path outside projects dir: ${target}`)
  }
}

function removeEntry(target: string, isDir: boolean): void {
  assertInsideProjects(target)
  if (isDir) fs.rmSync(target, { recursive: true, force: true })
  else fs.rmSync(target, { force: true })
}

async function main() {
  console.log(`• Storage root : ${STORAGE_ROOT}`)
  console.log(`• Projects dir : ${PROJECTS_DIR}`)
  console.log(`• Mode         : ${CONFIRM ? 'DELETE (--confirm)' : 'DRY RUN (report only)'}`)
  console.log('')

  if (!fs.existsSync(PROJECTS_DIR)) {
    console.log('No projects directory on disk — nothing to do.')
    return
  }

  // Snapshot the DB (include soft-deleted rows — those stay until the cron).
  const [projects, videos] = await Promise.all([
    prisma.project.findMany({ select: { id: true } }),
    prisma.video.findMany({ select: { id: true, originalStoragePath: true } }),
  ])
  const projectIds = new Set(projects.map((p) => p.id))
  const videoIds = new Set(videos.map((v) => v.id))
  const originalPaths = new Set(
    videos
      .map((v) => (v.originalStoragePath || '').replace(/^\/+/, ''))
      .filter(Boolean),
  )

  console.log(`DB: ${projectIds.size} projects, ${videoIds.size} videos.\n`)

  type Orphan = { label: string; path: string; isDir: boolean; size: number }
  const orphans: Orphan[] = []

  for (const projectId of fs.readdirSync(PROJECTS_DIR)) {
    if (projectId.startsWith('.')) continue // .DS_Store etc.
    const projectPath = path.join(PROJECTS_DIR, projectId)
    if (!fs.statSync(projectPath).isDirectory()) continue

    // 1) Whole project has no DB row → orphan directory.
    if (!projectIds.has(projectId)) {
      orphans.push({
        label: `project (no DB row)`,
        path: projectPath,
        isDir: true,
        size: dirSize(projectPath),
      })
      continue
    }

    const videosDir = path.join(projectPath, 'videos')
    if (!fs.existsSync(videosDir)) continue

    for (const entry of fs.readdirSync(videosDir, { withFileTypes: true })) {
      const full = path.join(videosDir, entry.name)

      // 2) Per-video asset dir (previews + hls + storyboard) with no Video row.
      //    Skip the shared `assets` dir (client attachments, handled elsewhere).
      if (entry.isDirectory()) {
        if (entry.name === 'assets') continue
        if (!videoIds.has(entry.name)) {
          orphans.push({
            label: `video assets (no DB row)`,
            path: full,
            isDir: true,
            size: dirSize(full),
          })
        }
        continue
      }

      // 3) Original master file not referenced by any Video row.
      if (entry.isFile() && entry.name.startsWith('original-')) {
        const rel = path
          .relative(STORAGE_ROOT, full)
          .split(path.sep)
          .join('/')
        if (!originalPaths.has(rel)) {
          orphans.push({
            label: `orphan original`,
            path: full,
            isDir: false,
            size: fs.statSync(full).size,
          })
        }
      }
    }
  }

  if (orphans.length === 0) {
    console.log('✓ No orphaned media found. Storage is clean.')
    return
  }

  let totalBytes = 0
  console.log('Orphans found:\n')
  for (const o of orphans) {
    totalBytes += o.size
    const rel = path.relative(STORAGE_ROOT, o.path)
    console.log(`  [${o.label}]  ${fmt(o.size).padStart(9)}  ${rel}`)
  }
  console.log(`\nTotal reclaimable: ${fmt(totalBytes)} across ${orphans.length} item(s).\n`)

  if (!CONFIRM) {
    console.log('DRY RUN — nothing deleted. Re-run with --confirm to remove the above.')
    return
  }

  let removed = 0
  let freed = 0
  for (const o of orphans) {
    try {
      removeEntry(o.path, o.isDir)
      removed += 1
      freed += o.size
      console.log(`✓ removed ${path.relative(STORAGE_ROOT, o.path)}`)
    } catch (err) {
      console.error(`✗ failed ${o.path}: ${(err as Error).message}`)
    }
  }
  console.log(`\nDone. Removed ${removed}/${orphans.length} item(s), freed ${fmt(freed)}.`)
}

main()
  .catch((err) => {
    console.error('Fatal:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
