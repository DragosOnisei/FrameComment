import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 1.5.8+: list every non-trashed folder in this project together with
 * the bits the Security tab needs to render its "shared folders"
 * panel: the folder name, its public share slug, its auth mode, and
 * the expiration timestamp (or null when the share never expires).
 *
 * Kept as a dedicated route rather than expanding the main project
 * GET response so the larger `/api/projects/[id]` payload stays the
 * same for everywhere else that consumes it (player page, dashboard
 * cards, share routes, etc.).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const adminCheck = await requireApiAdmin(request)
  if (adminCheck instanceof Response) return adminCheck

  try {
    const { id } = await params

    const folders = await prisma.folder.findMany({
      where: {
        projectId: id,
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        slug: true,
        authMode: true,
        shareExpiresAt: true,
        parentFolderId: true,
        sharePassword: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ parentFolderId: 'asc' }, { name: 'asc' }],
    })

    // 1.5.8: epoch-0 in `shareExpiresAt` is our sentinel for "share
    // link revoked via Project Settings → Delete link". We drop
    // those rows here so the Security tab shows only folders the
    // admin still considers shareable. Anything within the first
    // day of epoch counts as the sentinel (guards against rounding /
    // UTC drift); real-world expirations live in this decade and
    // pass through.
    const REVOKED_CUTOFF_MS = 24 * 60 * 60 * 1000 // 1970-01-02
    const filtered = folders.filter((f) => {
      if (!f.shareExpiresAt) return true
      return f.shareExpiresAt.getTime() >= REVOKED_CUTOFF_MS
    })

    // Strip the encrypted password — we only need to know whether one
    // exists (so the UI can show a "Password protected" badge), not
    // its contents. The actual decryption flow lives elsewhere.
    const sanitized = filtered.map((f) => ({
      id: f.id,
      name: f.name,
      slug: f.slug,
      authMode: f.authMode,
      shareExpiresAt: f.shareExpiresAt ? f.shareExpiresAt.toISOString() : null,
      parentFolderId: f.parentFolderId,
      hasPassword: !!f.sharePassword,
      // 3.2.6+: timestamps used by the Security tab's "Today / Last
      // week / …" share-link date filter. `updatedAt` is the field the
      // filter actually uses — it bumps when the folder is created, its
      // slug is rotated (re-share), or its share expiry changes, so it
      // tracks "when this share link was last (re)created/activated"
      // rather than just when the folder first came into existence.
      createdAt: f.createdAt.toISOString(),
      updatedAt: f.updatedAt.toISOString(),
    }))

    return NextResponse.json({ folders: sanitized })
  } catch (err) {
    logError('[PROJECT:SHARED_FOLDERS] GET failed', err)
    return NextResponse.json(
      { error: 'Failed to load shared folders' },
      { status: 500 },
    )
  }
}
