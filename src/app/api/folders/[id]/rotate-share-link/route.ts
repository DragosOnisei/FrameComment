import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { generateRandomSlug } from '@/lib/password-utils'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 1.5.8+: POST rotates a folder's public share slug. Anyone who has
 * the old `/share/folder/<old-slug>` URL is effectively locked out
 * because the route resolver will return 404 — the folder itself
 * and its videos are preserved, and a fresh slug is generated for
 * the next time the admin shares it.
 *
 * This is the "delete link" semantics the project settings page
 * uses: from the admin's perspective the existing share link is
 * gone, but the folder content stays put.
 *
 * Used by the Security tab's "Folder share links" panel.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const adminCheck = await requireApiAdmin(request)
  if (adminCheck instanceof Response) return adminCheck

  try {
    const { id } = await params

    const existing = await prisma.folder.findUnique({
      where: { id },
      select: { id: true },
    })
    if (!existing) {
      return NextResponse.json({ error: 'Folder not found' }, { status: 404 })
    }

    // Retry a handful of times if we collide with another folder's
    // slug. With 8–12 chars from a 31-char alphabet collisions are
    // already negligible, but the column has a unique constraint so
    // we'd rather catch and retry than throw a 500 at the user.
    //
    // 1.5.8: alongside rotating the slug we also stamp
    // `shareExpiresAt` to epoch 0 — used as a sentinel by the
    // shared-folders list endpoint to drop "revoked" folders from
    // the Security tab. Re-sharing via FolderBrowser sets a real
    // expiration (or null) and the row re-appears automatically.
    const SENTINEL_REVOKED = new Date(0)
    let newSlug = generateRandomSlug()
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const updated = await prisma.folder.update({
          where: { id },
          data: { slug: newSlug, shareExpiresAt: SENTINEL_REVOKED },
          select: { id: true, slug: true },
        })
        return NextResponse.json({ id: updated.id, slug: updated.slug })
      } catch (err: any) {
        // Prisma P2002 = unique constraint violation. Anything else
        // is fatal and we rethrow.
        if (err?.code !== 'P2002') throw err
        newSlug = generateRandomSlug()
      }
    }

    return NextResponse.json(
      { error: 'Failed to allocate a unique share slug after several attempts' },
      { status: 500 },
    )
  } catch (err) {
    logError('[FOLDER:ROTATE_SHARE_LINK] POST failed', err)
    return NextResponse.json({ error: 'Failed to rotate share link' }, { status: 500 })
  }
}
