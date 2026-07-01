import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

/**
 * 3.8.0+: the test-charge endpoint was removed for go-live. It only
 * existed to validate the charge flow in Stripe test mode; real billing
 * runs automatically via the monthly cycle. Kept as a disabled stub
 * (the sandbox can't delete the file); returns 410 Gone. Safe to
 * `git rm` this folder later.
 */
export async function POST() {
  return NextResponse.json({ error: 'Gone' }, { status: 410 })
}
