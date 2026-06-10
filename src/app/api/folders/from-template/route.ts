import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { generateUniqueFolderSlug } from '@/lib/folder-helpers'
import { logError } from '@/lib/logging'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 2.4.2+ POST /api/folders/from-template
 *
 * Materialise a multi-level folder scaffold under a project root
 * from one of two named templates. Replaces the manual "create
 * folder × N + drag-drop" dance the user was doing every episode
 * / campaign by hand.
 *
 * Templates (hard-coded — keeping them in code instead of a DB
 * table lets us refactor the shape freely without a migration,
 * and there are only two right now):
 *
 *   YOUTUBE — { day, episode } →
 *     <day>/                 (e.g., "Day7")
 *       <episode>/           (e.g., "Episode 12 - First Date")
 *         01_IN EDIT/
 *         02_CLEAN/
 *         03_FINAL/
 *
 *   UGC — { campaign, actors[] } →
 *     <campaign>/             (e.g., "Spring 2026 Push")
 *       <actor 1>/
 *         9:16/
 *         4:5/
 *       <actor 2>/
 *         9:16/
 *         4:5/
 *       ...
 *
 * Collision policy: per the design call, the top-level template
 * folder (Day/Campaign) auto-renames on collision with a "(1)",
 * "(2)" suffix so a user can re-run the wizard for the same
 * shooting day without manually deleting anything first. Deeper
 * folders never collide because they live inside the freshly-
 * created top-level wrapper, so we don't bother re-checking them.
 *
 * Everything happens inside a single `prisma.$transaction` — if
 * any insert fails, no half-built tree survives. The transaction
 * returns the top-level folder so the caller can deep-link the
 * user straight into it.
 */

const youtubeSchema = z.object({
  template: z.literal('youtube'),
  projectId: z.string().min(1),
  params: z.object({
    day: z.string().trim().min(1, 'Day folder name is required').max(120),
    episode: z.string().trim().min(1, 'Episode name is required').max(120),
  }),
})

const ugcSchema = z.object({
  template: z.literal('ugc'),
  projectId: z.string().min(1),
  params: z.object({
    campaign: z.string().trim().min(1, 'Campaign name is required').max(120),
    actors: z
      .array(z.string().trim().min(1).max(120))
      .min(1, 'At least one actor is required')
      .max(50, 'Too many actors (max 50)'),
  }),
})

const requestSchema = z.discriminatedUnion('template', [youtubeSchema, ugcSchema])

/**
 * Pick a folder name that doesn't collide with an existing sibling
 * under the same (projectId, parentFolderId) bucket. Walks up
 * `name`, `name (1)`, `name (2)`, … and returns the first free
 * slot. Bounded at 100 tries — past that something is very wrong
 * and we'd rather surface an error than spin forever.
 */
async function pickUniqueFolderName(
  base: string,
  projectId: string,
  parentFolderId: string | null,
): Promise<string> {
  const trimmedBase = base.trim()
  for (let i = 0; i < 100; i += 1) {
    const candidate = i === 0 ? trimmedBase : `${trimmedBase} (${i})`
    const existing = await prisma.folder.findFirst({
      where: {
        projectId,
        parentFolderId,
        name: candidate,
        deletedAt: null,
      },
      select: { id: true },
    })
    if (!existing) return candidate
  }
  throw new Error(`Could not find a unique name for "${base}" after 100 attempts`)
}

/**
 * Create a single folder row. Used as the inner building block of
 * the template materialiser — keeps the transaction call sites
 * tiny and avoids repeating the `generateUniqueFolderSlug` +
 * default-auth-mode boilerplate at every level.
 */
async function createFolder(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  data: {
    projectId: string
    parentFolderId: string | null
    name: string
    createdById: string | null
  },
) {
  const slug = await generateUniqueFolderSlug()
  return tx.folder.create({
    data: {
      projectId: data.projectId,
      parentFolderId: data.parentFolderId,
      name: data.name,
      slug,
      authMode: 'NONE',
      createdById: data.createdById,
    },
    select: { id: true, name: true, slug: true, parentFolderId: true },
  })
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  // Templates can fan out into 100+ folder rows on a big UGC
  // campaign — match the per-folder POST limit so the throughput
  // is comparable.
  const rl = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 20,
      message: 'Too many template requests. Please slow down.',
    },
    'admin-folders-from-template',
  )
  if (rl) return rl

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.format() },
      { status: 400 },
    )
  }

  const data = parsed.data

  // Sanity-check the project exists before we open a transaction
  // (and especially before we allocate a bunch of slugs).
  const project = await prisma.project.findUnique({
    where: { id: data.projectId },
    select: { id: true, deletedAt: true },
  })
  if (!project || project.deletedAt) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  try {
    const createdById = authResult.id || null
    // The top-level wrapper name needs collision handling. Resolve
    // it OUTSIDE the transaction (it's a read) so we don't hold a
    // write lock open while iterating.
    const topLevelBase =
      data.template === 'youtube' ? data.params.day : data.params.campaign
    const topLevelName = await pickUniqueFolderName(
      topLevelBase,
      data.projectId,
      null,
    )

    const result = await prisma.$transaction(async (tx) => {
      const root = await createFolder(tx, {
        projectId: data.projectId,
        parentFolderId: null,
        name: topLevelName,
        createdById,
      })

      if (data.template === 'youtube') {
        // <day>/<episode>/{01_IN EDIT, 02_CLEAN, 03_FINAL}
        const episode = await createFolder(tx, {
          projectId: data.projectId,
          parentFolderId: root.id,
          name: data.params.episode.trim(),
          createdById,
        })
        for (const leaf of ['01_IN EDIT', '02_CLEAN', '03_FINAL']) {
          await createFolder(tx, {
            projectId: data.projectId,
            parentFolderId: episode.id,
            name: leaf,
            createdById,
          })
        }
        return { root, episodeId: episode.id, foldersCreated: 5 }
      }

      // UGC: <campaign>/<actor>/{9:16, 4:5} for each actor
      let count = 1 // the campaign root
      for (const rawActor of data.params.actors) {
        const actorName = rawActor.trim()
        if (!actorName) continue
        const actor = await createFolder(tx, {
          projectId: data.projectId,
          parentFolderId: root.id,
          name: actorName,
          createdById,
        })
        count += 1
        for (const leaf of ['9:16', '4:5']) {
          await createFolder(tx, {
            projectId: data.projectId,
            parentFolderId: actor.id,
            name: leaf,
            createdById,
          })
          count += 1
        }
      }
      return { root, foldersCreated: count }
    })

    return NextResponse.json(
      {
        success: true,
        template: data.template,
        rootFolder: {
          id: result.root.id,
          name: result.root.name,
          slug: result.root.slug,
        },
        foldersCreated: result.foldersCreated,
        // Surface the renamed base so the toast can say "Created
        // 'Day7 (1)' (Day7 was taken)" instead of silently picking
        // a new name behind the user's back.
        topLevelRenamed: topLevelName !== topLevelBase
          ? { requested: topLevelBase, actual: topLevelName }
          : null,
      },
      { status: 201 },
    )
  } catch (error) {
    logError('[POST /api/folders/from-template] failed:', error)
    return NextResponse.json(
      { error: 'Failed to create folders from template' },
      { status: 500 },
    )
  }
}
