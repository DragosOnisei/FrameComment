/**
 * Short-link slug generator + resolver (2.4.0+).
 *
 * Backs the Frame.io-style URL shortener that turns
 *   https://framecomment.example.com/share/<projectSlug>?v=<vSlug>&sig=<HMAC>
 * into
 *   https://fcmt.io/aBc12XyZ
 *
 * Resolution is a single DB read on `Host: fcmt.io` (the
 * middleware narrows /<slug> → ShortLink record → 302 redirect to
 * targetUrl). No auth required because the original URL carries
 * its own HMAC signature + expiry.
 *
 * Slug alphabet (URL-safe, low confusion):
 *   - 51 chars total: `[A-Z][a-z][2-9]` minus 0/O/o/1/I/l (chars that
 *     look alike in default sans-serif fonts)
 *   - 8 chars long → 51^8 ≈ 4.5×10^13 combinations. With a 100k-share
 *     instance the birthday-bound collision probability is in the
 *     1-in-10^6 range, and we retry on collision anyway.
 */

import { randomInt } from 'node:crypto'
import { prisma } from './db'
import { logError } from './logging'

// 51 chars, no 0/O/o/1/I/l — those four are the standard "looks
// alike at a glance" set across helvetica, inter, arial.
const SLUG_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
const SLUG_LENGTH = 8
const MAX_COLLISION_RETRIES = 5

/**
 * Generates a single random 8-char slug from the URL-safe alphabet.
 * Uses `crypto.randomInt` so each character has a uniform
 * distribution — picking `Math.random() * alphabet.length` would
 * lean slightly toward the lower indexes because the alphabet
 * length doesn't divide 2^32 evenly.
 */
export function generateSlug(length: number = SLUG_LENGTH): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += SLUG_ALPHABET[randomInt(0, SLUG_ALPHABET.length)]
  }
  return out
}

/**
 * Persist a ShortLink row, retrying on the (vanishingly rare)
 * slug collision. Returns the slug — caller is expected to know
 * the configured `shortLinkDomain` and assemble the full URL.
 *
 * `expiresAt` should be copied from the underlying share's
 * expiration so the tidy URL dies the same moment the long one
 * does. NULL = never expires (matches the share's lack of expiry).
 */
export async function createShortLink(
  targetUrl: string,
  expiresAt: Date | null,
): Promise<{ slug: string; id: string }> {
  // Bound the retries — a real collision means the alphabet is
  // exhausted by an attacker spamming us, not a normal hot run.
  for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
    const slug = generateSlug()
    try {
      const row = await prisma.shortLink.create({
        data: { slug, targetUrl, expiresAt },
        select: { id: true, slug: true },
      })
      return row
    } catch (err) {
      // P2002 is Prisma's unique-constraint code. Anything else
      // (DB down, schema drift, etc.) we surface immediately.
      const code = (err as { code?: string })?.code
      if (code !== 'P2002') throw err
      // Otherwise loop and try a different slug.
      if (attempt === MAX_COLLISION_RETRIES - 1) {
        logError(
          `[short-link] giving up after ${MAX_COLLISION_RETRIES} slug collisions — alphabet exhausted?`,
        )
        throw err
      }
    }
  }
  // Unreachable in practice — the loop either returns or throws.
  throw new Error('createShortLink: exhausted retries without a result')
}

/**
 * Resolve a slug to its target URL. Returns null when:
 *   - the slug doesn't exist (404 to the user)
 *   - the link is past its `expiresAt` (410 to the user)
 *
 * Used by the /s/[slug] route handler. We don't track clicks in
 * 2.4.0 per user request, so this is a one-shot read — no write
 * back to the DB on hit.
 */
export async function resolveShortLink(
  slug: string,
): Promise<{ targetUrl: string; expired: boolean } | null> {
  const row = await prisma.shortLink.findUnique({
    where: { slug },
    select: { targetUrl: true, expiresAt: true },
  })
  if (!row) return null
  const expired =
    row.expiresAt != null && row.expiresAt.getTime() <= Date.now()
  return { targetUrl: row.targetUrl, expired }
}

/**
 * Build the full short URL from a slug + configured domain.
 * Centralised so settings → modal → email rendering all agree
 * on the format. We strip any accidental `https://` or trailing
 * slash the admin might have pasted in.
 */
export function buildShortUrl(domain: string, slug: string): string {
  const cleaned = domain
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
  return `https://${cleaned}/${slug}`
}
