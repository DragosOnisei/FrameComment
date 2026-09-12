import { NextResponse } from 'next/server'
import sharp from 'sharp'
import { buildLogoSvg, getAccentColor } from '@/lib/brand'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 7.8.1: the logomark as a 192×192 PNG, for push notifications.
 *
 * Every push payload used to point its icon at /brand/icon-192.svg. Chrome on
 * macOS hands notifications to the system, and the system accepts only raster
 * images as attachments — an SVG icon made the WHOLE notification disappear:
 * no banner, no entry in Notification Center, no error anywhere, while the
 * push service happily reported the message delivered. Dragos's own test on
 * another site was the tell: "service worker, no icon" showed, the variant
 * with an SVG icon did not. Rendered here from the same SVG the favicon uses,
 * so the accent colour matches the app.
 *
 * Public on purpose, like the SVG routes: the browser fetches it from the
 * service worker, with no session.
 */
export async function GET() {
  const accent = await getAccentColor()
  const svg = buildLogoSvg(accent, 192)
  const png = await sharp(Buffer.from(svg), { density: 288 })
    .resize(192, 192)
    .png()
    .toBuffer()

  return new NextResponse(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      // An hour: the notification icon is fetched on every push, and the
      // accent colour changes rarely.
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
