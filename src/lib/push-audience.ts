/**
 * 7.17.0: who gets the company-wide "New comment on <video>" push.
 *
 * Since 7.8.3 every enrolled device is subscribed to CLIENT_COMMENT, and
 * `sendPushNotifications` sent that event to every such device. So when a
 * client commented on Victor's cut, Alin's Mac rang too (reported by Dragos
 * on 2026-10-01 with the "New comment on BIG RAY_CEMENT" banner) — an editor
 * being woken for a video that was never theirs. The bell has targeted the
 * right people since 6.x (uploader + every Project Manager); this broadcast
 * never did.
 *
 * The rule, stated by Dragos: editors hear about THEIR uploads only;
 * Project Managers keep hearing about everything. Applied by role level:
 * the content-only roles (level 50 in permissions.ts — Editor, Senior Video
 * Editor, Team Leader, Marketing, Producer) receive the push for a video only
 * when they uploaded it; Owner, Admin and Project Manager receive it for
 * every video, as before. A device whose user is unknown, or a video whose
 * uploader is unknown (rows older than `createdById`), falls back to the old
 * behaviour for the privileged roles and to silence for the content roles —
 * a wrong-video ping is the complaint, a missed one on a legacy row is not.
 *
 * Pure, so a node script checks it; `sendPushNotifications` supplies the
 * rows.
 */

export const CONTENT_ONLY_ROLES: ReadonlySet<string> = new Set([
  'EDITOR',
  'SENIOR_VIDEO_EDITOR',
  'TEAM_LEADER',
  'MARKETING',
  'PRODUCER',
])

export interface AudienceDevice<T = unknown> {
  device: T
  userId: string | null | undefined
  role: string | null | undefined
}

/**
 * The devices that should receive a CLIENT_COMMENT push about a video
 * uploaded by `uploaderId`. Devices are returned in their original order.
 */
export function clientCommentAudience<T>(
  devices: AudienceDevice<T>[],
  uploaderId: string | null | undefined,
): T[] {
  const out: T[] = []
  for (const d of devices) {
    const role = (d.role || '').toUpperCase()
    if (!CONTENT_ONLY_ROLES.has(role)) {
      out.push(d.device) // Owner / Admin / Project Manager: everything
      continue
    }
    if (uploaderId && d.userId && d.userId === uploaderId) out.push(d.device)
  }
  return out
}
