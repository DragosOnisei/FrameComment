import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prismaPrivileged } from '@/lib/db'
import { requirePlatformAdmin } from '@/lib/platform'
import { safeParseBody } from '@/lib/validation'
import { deleteFile } from '@/lib/storage'
import { publishNotification, serializeNotification } from '@/lib/inapp-notifications'
import { logError, logMessage } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  status: z.enum(['NEW', 'READ', 'DONE']),
  /**
   * 7.3.1: what the sender is told. Optional — an empty note marks the report
   * handled silently, which is the right behaviour for the ones I file against
   * my own app while testing.
   */
  note: z.string().trim().max(2000).optional(),
})

/**
 * 7.3.0 — the founder moves a report along. Founder only: a sender can write
 * feedback but has no business marking their own report handled.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  const { id } = await params
  const parsed = await safeParseBody(request)
  if (!parsed.success) return parsed.response
  const validation = patchSchema.safeParse(parsed.data)
  if (!validation.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }
  const { status, note } = validation.data

  try {
    const feedback = await prismaPrivileged.feedback.update({
      where: { id },
      data: { status },
      select: { id: true, userId: true, kind: true, message: true },
    })

    // 7.3.1: telling the sender what happened.
    //
    // Only on DONE, and only when there is something to say. Un-marking a
    // report is a correction to my own bookkeeping, not news to anybody, and a
    // bell that pings on every state change would train people to ignore it.
    let notified = false
    if (status === 'DONE' && note && feedback.userId) {
      notified = await notifyReporter({
        recipientId: feedback.userId,
        actorName: auth.name || 'FrameComment',
        note,
      })
    }

    return NextResponse.json({ ok: true, notified })
  } catch (error) {
    logError('[feedback] status change failed:', error, id)
    return NextResponse.json({ error: 'Could not update' }, { status: 500 })
  }
}

/**
 * 7.3.1 — the reply lands in the sender's own notification bell.
 *
 * THE ORGANISATION ID IS THE WHOLE PROBLEM HERE
 *
 * Feedback rows are platform-level and carry no tenancy, but `Notification` is
 * an ordinary tenant table read back through the ARMED client — `listNotifications`
 * uses `prisma`, so RLS filters it by whichever organisation the reader is
 * browsing as. Stamping the row with the organisation recorded on the feedback
 * would look right and work most of the time, and then silently fail for
 * anybody who changed company between sending a report and being answered:
 * the row would exist, the write would report success, and the bell would
 * never show it. So the recipient's CURRENT organisation is read at send time
 * and used instead. Same class of trap as the raw-SQL one in CLAUDE.md — a
 * write that succeeds against nothing.
 *
 * Never throws. A report that was marked handled must stay marked handled even
 * if the bell could not be rung.
 */
async function notifyReporter(params: {
  recipientId: string
  actorName: string
  note: string
}): Promise<boolean> {
  const { recipientId, actorName, note } = params
  try {
    const recipient = await prismaPrivileged.user.findUnique({
      where: { id: recipientId },
      select: { id: true, organizationId: true },
    })
    // The account was deleted between sending the report and being answered.
    if (!recipient?.organizationId) {
      logMessage(`[feedback] no live recipient for the reply — not delivered (${recipientId})`)
      return false
    }

    const row = await (prismaPrivileged as any).notification.create({
      data: {
        organizationId: recipient.organizationId,
        recipientId,
        // A string, deliberately: `Notification.type` is untyped precisely so a
        // new signal costs no migration. There is no project or video on this
        // one, so the bell's deep link resolves to null and clicking it just
        // marks it read — the same shape EARLY_ACCESS has had since 5.14.
        type: 'FEEDBACK_UPDATE',
        actorName,
        message: note,
      },
    })
    await publishNotification(recipientId, serializeNotification(row))
    return true
  } catch (error) {
    logError('[feedback] could not notify the sender:', error, recipientId)
    return false
  }
}

/**
 * 7.3.1 — throw a report away.
 *
 * The attachment ROWS go with it through the cascade declared on the relation,
 * but the FILES do not: nothing else in the schema knows they exist, so
 * deleting the row without unlinking them leaves bytes on the volume with
 * no record pointing at them, which is the worst possible kind of orphan —
 * invisible and permanent.
 *
 * Unlike comment attachments, these never share a `storagePath` with another
 * row (there is no copy-paste path into feedback), so there is nothing to
 * refcount and each file can go directly.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  const { id } = await params

  try {
    const feedback = await prismaPrivileged.feedback.findUnique({
      where: { id },
      select: {
        id: true,
        attachments: {
          select: { id: true, storagePath: true, storageBackend: true },
        },
      },
    })
    if (!feedback) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // Files first, and each one on its own: a single unlink that fails (the
    // file was already gone, the volume is read-only) must not strand the
    // other three or abort the delete. A report the founder asked to remove
    // has to disappear from the inbox either way.
    for (const attachment of feedback.attachments) {
      try {
        await deleteFile(
          attachment.storagePath,
          (attachment.storageBackend as any) || undefined,
        )
      } catch (error) {
        logError('[feedback] attachment file not removed:', error, attachment.id)
      }
    }

    await prismaPrivileged.feedback.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (error) {
    logError('[feedback] delete failed:', error, id)
    return NextResponse.json({ error: 'Could not delete' }, { status: 500 })
  }
}
