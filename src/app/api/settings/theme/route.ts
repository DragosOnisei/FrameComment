import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Public endpoint to get appearance settings (theme and accent color)
 * No authentication required - this is needed for initial page load
 */
export async function GET() {
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: {
        defaultTheme: true,
        accentColor: true,
        brandingLogoPath: true,
        // 1.6.1+: expose `appDomain` here so the admin UI can mint
        // share links that point to the public domain even when the
        // operator is browsing over LAN (192.168…). Cloudflare-Tunnel
        // setups need this — see `getPublicShareOrigin()` on the
        // client for the lookup logic.
        appDomain: true,
      },
    })

    return NextResponse.json({
      // 3.6.x: dark is the app default (see layout bootstrap).
      defaultTheme: settings?.defaultTheme || 'dark',
      accentColor: settings?.accentColor || 'blue',
      brandingLogoPath: settings?.brandingLogoPath || null,
      appDomain: settings?.appDomain || null,
    })
  } catch (error) {
    // Default values on error
    return NextResponse.json({ defaultTheme: 'dark', accentColor: 'blue', brandingLogoPath: null, appDomain: null })
  }
}
