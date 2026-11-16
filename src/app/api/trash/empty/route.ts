/**
 * POST /api/trash/empty
 *
 * Permanently delete every soft-deleted item right now (1.0.8+).
 * Used by the "Empty Trash" button on the Trash page. Routes through
 * the same hard-delete helpers as the 30-day cleanup so the underlying
 * storage files get cleaned up alongside the DB rows.
 *
 * 7.21.0: the Trash is personal (src/lib/trash-scope.ts). The button
 * empties what the caller is looking at: their own deletions plus the
 * unattributed ones by default, the whole team's for an Owner or Admin
 * who switched the page to "All team" (`?scope=all`).
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { logError } from '@/lib/logging'
import { effectiveTrashScope, purgeTrash, trashOwnerWhere } from '@/lib/trash-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult
  const viewer = authResult as any

  const rl = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 6,
    message: 'Too many requests. Please slow down.',
  }, 'admin-trash-empty')
  if (rl) return rl

  try {
    const scope = effectiveTrashScope(viewer, new URL(request.url).searchParams.get('scope'))
    const { removed } = await purgeTrash(trashOwnerWhere(viewer, scope), `empty by ${viewer.id}`)
    return NextResponse.json({ success: true, removed })
  } catch (error) {
    logError('[POST /api/trash/empty] failed:', error)
    return NextResponse.json({ error: 'Failed to empty trash' }, { status: 500 })
  }
}
