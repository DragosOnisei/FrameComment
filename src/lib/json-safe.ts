/**
 * 6.9.1 — make any Prisma row safe to hand to NextResponse.json.
 *
 * Why this exists: `JSON.stringify` throws on BigInt ("Do not know how to
 * serialize a BigInt"), and several routes return video rows by spreading the
 * whole record and converting the ONE BigInt column they knew about. That
 * works right up until someone adds another BigInt column — which is exactly
 * what happened when 6.9.0 added the per-tier size fields: the moment a video
 * had a size recorded, the project it belonged to stopped loading.
 *
 * Converting field-by-field is a rule you have to remember. This converts by
 * type, so the next BigInt column can't repeat the outage.
 *
 * BigInt becomes a STRING, matching what `originalFileSize` already returned —
 * numbers here can exceed Number.MAX_SAFE_INTEGER, and silently losing
 * precision would be a worse bug than the crash it replaces.
 */
export function jsonSafe<T>(value: T): T {
  return convert(value) as T
}

function convert(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date) return value
  if (Array.isArray(value)) return value.map(convert)

  // Plain objects only. Anything exotic (Buffer, Decimal, class instances)
  // is left alone rather than being rebuilt into something it isn't.
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = convert(v)
  }
  return out
}
