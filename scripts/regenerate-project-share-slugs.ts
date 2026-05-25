/**
 * 1.4.x+ SECURITY MIGRATION: regenerate project share slugs as
 * unguessable random tokens.
 *
 * Background: the original `Project.slug` field was derived from the
 * project title (e.g. "VDA" → `vda`). The public share URL
 * `/share/<slug>` therefore had a very small, guessable namespace —
 * anyone could probe `/share/<commonname>` and stumble onto a project.
 * Per-folder shares were not enough to compensate because the project
 * share route bypassed them entirely.
 *
 * This script walks every Project row (including soft-deleted ones —
 * we don't want to leave an old guessable URL alive on a restore) and
 * rewrites `slug` to a fresh 12-character base64url random string
 * (~72 bits of entropy). After running this once, all existing public
 * share URLs `/share/<old-slug>` return 404 and you must re-share the
 * new URL with anyone who still needs access.
 *
 * Folder slugs are NOT touched — `generateUniqueFolderSlug` already
 * produced random tokens since 1.0.6.
 *
 * Usage (local dev with the same env the app uses):
 *   npx tsx --env-file=.env scripts/regenerate-project-share-slugs.ts
 *
 * The script is idempotent in spirit (re-running it just mints new
 * tokens), but you'd typically run it ONCE during upgrade. To skip
 * already-randomised slugs, the script checks for slug shape: if a
 * slug already looks like a 12-character base64url token, we leave it
 * alone. Pass `--force` to ignore the heuristic and rotate everything.
 */
import { randomBytes } from 'crypto'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

function looksRandom(slug: string): boolean {
  // 12-character base64url is the format produced by `randomBytes(9)`.
  // base64url charset: A-Z, a-z, 0-9, -, _ (no padding).
  return /^[A-Za-z0-9_-]{12}$/.test(slug)
}

async function mintUniqueSlug(): Promise<string> {
  for (let i = 0; i < 8; i += 1) {
    const candidate = randomBytes(9).toString('base64url')
    const clash = await prisma.project.findUnique({
      where: { slug: candidate },
      select: { id: true },
    })
    if (!clash) return candidate
  }
  // Widen the key on the absurdly unlikely all-collision case.
  return randomBytes(18).toString('base64url')
}

async function main() {
  const force = process.argv.includes('--force')
  const projects = await prisma.project.findMany({
    select: { id: true, title: true, slug: true },
  })

  let touched = 0
  for (const p of projects) {
    if (!force && looksRandom(p.slug)) {
      // Already a random token, skip.
      continue
    }
    const next = await mintUniqueSlug()
    await prisma.project.update({
      where: { id: p.id },
      data: { slug: next },
    })
    // eslint-disable-next-line no-console
    console.log(
      `[migrate] ${p.title} (${p.id}): ${p.slug} → ${next}`,
    )
    touched += 1
  }
  // eslint-disable-next-line no-console
  console.log(`[migrate] done — ${touched} / ${projects.length} project slugs rewritten`)
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[migrate] FAILED:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
