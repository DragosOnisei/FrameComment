/**
 * 5.6 multi-tenant Phase 4: shared bits for team-invite links.
 *
 * The link carries a RAW random token; the DB stores only its sha256. Both
 * the minting route (/api/team-invites) and the public resolution routes
 * (/api/invite/[token]) must hash identically — hence this tiny module.
 */

import crypto from 'crypto'

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days (user decision)

export function hashInviteToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('base64url')
}

/** Raw token format sanity check (32 bytes base64url = 43 chars). */
export function looksLikeInviteToken(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{40,50}$/.test(raw)
}
