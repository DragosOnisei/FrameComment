#!/usr/bin/env node
/**
 * 6.21.0 — retroactively mark comments that were pasted in from an earlier cut.
 *
 * WHY THIS EXISTS
 *
 * The statement that stamps `isCopied` / `sourceVideoId` / `sourceVersionLabel`
 * on a pasted comment was a bare `$executeRawUnsafe`, and raw statements are not
 * armed with the RLS organization context. After the multi-tenant flip it
 * therefore matched zero rows on production and reported success, so every
 * comment carried forward since then looks, in the database, exactly like a
 * comment somebody typed. Two visible consequences: no "from vX" tag and no
 * grey timeline marker, and — worse — the "notify on the first comment of a
 * version" rule counted them as real feedback and went silent.
 *
 * 6.21.0 fixes the write. This script repairs the rows already in the database.
 *
 * HOW IT DECIDES, AND WHY IT IS A GUESS
 *
 * A pasted comment is recognised by having a twin on an EARLIER version of the
 * same stack: identical `content`, identical `timecode`, same stack, lower
 * version number. That is a deliberately narrow rule — two people independently
 * writing the same words at the same frame of two different cuts is possible but
 * vanishingly unlikely, whereas "same second" or "same author" would sweep up
 * genuine comments.
 *
 * It is still inference, not knowledge: the information that would settle it was
 * never written down. So the default is a DRY RUN that prints exactly what it
 * would change and touches nothing. Read the list, then re-run with --apply.
 *
 * Deliberately narrow in one more way: it only ever sets these three columns,
 * and only on rows where `isCopied` is currently false. It cannot un-mark
 * anything, and re-running it is a no-op.
 *
 * Usage:
 *   node scripts/backfill-copied-comments.mjs            # dry run (default)
 *   node scripts/backfill-copied-comments.mjs --apply    # write the changes
 *   node scripts/backfill-copied-comments.mjs --limit 50 # cap rows examined
 *
 * Connects with DATABASE_URL_PRIVILEGED when set (the role that bypasses RLS),
 * falling back to DATABASE_URL. It must NOT run as the restricted application
 * role: without an organization context every statement here would match zero
 * rows, which is the exact bug being repaired.
 */

import { PrismaClient } from '@prisma/client'

const APPLY = process.argv.includes('--apply')
const limitArg = process.argv.indexOf('--limit')
const LIMIT = limitArg !== -1 ? Number(process.argv[limitArg + 1]) : null

if (limitArg !== -1 && (!Number.isFinite(LIMIT) || LIMIT <= 0)) {
  console.error('--limit needs a positive number')
  process.exit(1)
}

const url = process.env.DATABASE_URL_PRIVILEGED || process.env.DATABASE_URL
if (!url) {
  console.error('Set DATABASE_URL_PRIVILEGED (preferred) or DATABASE_URL.')
  process.exit(1)
}

const prisma = new PrismaClient({ datasources: { db: { url } } })

/*
 * One query does the matching, in the database, because the alternative is
 * pulling every comment into Node and joining by hand.
 *
 *  - `c` is the candidate (the possibly-pasted comment) on video `v`
 *  - `o` is its twin on `w`, an EARLIER version of the same stack
 *  - DISTINCT ON keeps one source per candidate: the NEWEST earlier version
 *    that matches, which is the cut a person would actually have pasted from
 *
 * Both videos must share a non-null stackId; a video with no stack has no
 * earlier version to have been pasted from.
 */
const CANDIDATE_SQL = `
  SELECT DISTINCT ON (c.id)
         c.id           AS comment_id,
         c.content      AS content,
         c.timecode     AS timecode,
         v.id           AS video_id,
         v.name         AS video_name,
         v."versionLabel" AS video_label,
         w.id           AS source_video_id,
         w."versionLabel" AS source_label,
         w.version      AS source_version
    FROM "Comment" c
    JOIN "Video"   v ON v.id = c."videoId"
    JOIN "Video"   w ON w."stackId" = v."stackId"
                    AND w.version   < v.version
    JOIN "Comment" o ON o."videoId" = w.id
                    AND o.content   = c.content
                    AND o.timecode  = c.timecode
   WHERE c."isCopied" = false
     AND v."stackId" IS NOT NULL
   ORDER BY c.id, w.version DESC
`

function truncate(text, max = 60) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

async function main() {
  const rows = await prisma.$queryRawUnsafe(
    LIMIT ? `${CANDIDATE_SQL} LIMIT ${LIMIT}` : CANDIDATE_SQL,
  )

  if (rows.length === 0) {
    console.log('Nothing to backfill: no comment has a twin on an earlier version of its stack.')
    return
  }

  // Grouped by video so the output reads as "this cut received these notes",
  // which is the shape a person can actually sanity-check.
  const byVideo = new Map()
  for (const r of rows) {
    if (!byVideo.has(r.video_id)) byVideo.set(r.video_id, [])
    byVideo.get(r.video_id).push(r)
  }

  console.log(
    `${rows.length} comment(s) across ${byVideo.size} video(s) look carried over.\n` +
    `${APPLY ? 'APPLYING' : 'DRY RUN — nothing will be written'}\n`,
  )

  for (const [, group] of byVideo) {
    const first = group[0]
    console.log(`  ${first.video_name} ${first.video_label}  ← ${first.source_label}`)
    for (const r of group) {
      console.log(`      ${r.timecode}  "${truncate(r.content)}"`)
    }
  }

  if (!APPLY) {
    console.log('\nRe-run with --apply to write these changes.')
    return
  }

  let updated = 0
  for (const r of rows) {
    // Row by row on purpose: each carries its own source video, and an
    // ops script that reports a precise number is worth more than one that
    // finishes a few hundred milliseconds sooner.
    updated += await prisma.$executeRawUnsafe(
      `UPDATE "Comment"
          SET "isCopied" = true, "sourceVideoId" = $2, "sourceVersionLabel" = $3
        WHERE id = $1 AND "isCopied" = false`,
      r.comment_id,
      r.source_video_id,
      r.source_label,
    )
  }

  console.log(`\nUpdated ${updated} comment(s).`)
  if (updated !== rows.length) {
    console.log(
      `Note: ${rows.length - updated} row(s) were already marked by the time the ` +
      `update ran (concurrent write, or a second run). Nothing was lost.`,
    )
  }
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
