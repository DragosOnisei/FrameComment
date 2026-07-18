import { NextRequest, NextResponse } from 'next/server'
import { requireApiAdmin } from '@/lib/auth'
import { logError } from '@/lib/logging'
import { computeBillingUsage, computeTotalStorageBytes } from '@/lib/billing'
import { getActiveBackend, backendLabel } from '@/lib/storage-backends'

export const runtime = 'nodejs'

/**
 * 1.9.1+: GET /api/settings/billing/usage
 *
 * Returns the running totals that drive the Billing pane in
 * Global Settings. Pricing is currently a flat tariff applied
 * client-side (UI-only — no Stripe connection yet):
 *   $25 / user / month
 *   $0.10 / GB / month
 *
 * Storage covers EVERY file the app holds (VideoAsset +
 * ProjectUpload), INCLUDING soft-deleted projects/folders in
 * Trash. Users counts every row in the User table regardless of
 * recent activity. Both choices come from the user's billing
 * spec ("all users", "everything including trash").
 *
 * Auth: admin only.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  try {
    // 4.2.0+ (Phase 3): storageBytes here is the BILLABLE storage — only bytes
    // on the FrameComment Server backend ('fc') are charged per-GB (Local / R2
    // / AWS are the customer's own storage). computeBillingUsage applies that
    // filter. We also return the customer's TOTAL storage across all backends
    // + the active backend so the Billing pane can explain why per-GB may be $0.
    const [usage, totalStorageBytes, activeBackend] = await Promise.all([
      computeBillingUsage(),
      computeTotalStorageBytes(),
      getActiveBackend(),
    ])

    return NextResponse.json({
      userCount: usage.userCount,
      storageBytes: usage.storageBytes, // billable (fc only)
      totalStorageBytes, // all backends — for display context
      activeBackend,
      activeBackendLabel: backendLabel(activeBackend),
      storageBilledOnBackend: 'fc',
      // Echo the unit prices so the client doesn't have to hard-code
      // them — keeping the source of truth here makes a future
      // pricing change a single-file edit.
      pricing: {
        currency: 'USD',
        perUserPerMonth: 25,
        perGigabytePerMonth: 0.1,
      },
    })
  } catch (err) {
    logError('[billing/usage]', err)
    return NextResponse.json(
      { error: 'Failed to compute billing usage' },
      { status: 500 },
    )
  }
}
