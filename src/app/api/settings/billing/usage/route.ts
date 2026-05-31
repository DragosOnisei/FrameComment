import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { logError } from '@/lib/logging'

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
    // 1.9.2+: count three storage sources, not just VideoAsset.
    // - Video.originalFileSize is the master file uploaded by the
    //   admin (the bulk of storage — usually multi-GB per video).
    // - VideoAsset.fileSize is the extra files attached to a video
    //   (comment attachments, project files, audio, images).
    // - ProjectUpload.fileSize is reverse-share / client-side
    //   uploads that aren't directly attached to a video.
    // The original v1.9.2 release only summed VideoAsset, which
    // reported KBs while the project actually had GBs of master
    // files.
    const [userCount, videoSum, videoAssetSum, projectUploadSum] =
      await Promise.all([
        prisma.user.count(),
        prisma.video.aggregate({ _sum: { originalFileSize: true } }),
        prisma.videoAsset.aggregate({ _sum: { fileSize: true } }),
        prisma.projectUpload.aggregate({ _sum: { fileSize: true } }),
      ])

    // BigInt aggregate sums come back as BigInt | null. Coerce to
    // Number for the JSON response — billing is in dollars, the
    // precision loss past 2^53 bytes (~9 PB) is theoretical.
    const masterBytes = videoSum._sum.originalFileSize
      ? Number(videoSum._sum.originalFileSize)
      : 0
    const assetBytes = videoAssetSum._sum.fileSize
      ? Number(videoAssetSum._sum.fileSize)
      : 0
    const uploadBytes = projectUploadSum._sum.fileSize
      ? Number(projectUploadSum._sum.fileSize)
      : 0
    const storageBytes = masterBytes + assetBytes + uploadBytes

    return NextResponse.json({
      userCount,
      storageBytes,
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
