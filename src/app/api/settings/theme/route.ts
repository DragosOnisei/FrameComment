import { NextRequest, NextResponse } from 'next/server'
import { prisma, orgSettingsWhere } from '@/lib/db'
import { getCurrentUserFromRequest } from '@/lib/auth'
import { canonicalPublicOrigin } from '@/lib/url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Public endpoint to get appearance settings (theme and accent color)
 * No authentication required - this is needed for initial page load
 *
 * 5.6.1 multi-tenant: OPTIONAL auth — when the caller sends a bearer token,
 * the guard arms the org context so each company gets ITS OWN theme/branding
 * (incl. the company name shown in the sidebar). Anonymous callers (login
 * page) keep getting the platform defaults exactly as before.
 */
export async function GET(request: NextRequest) {
  try {
    await getCurrentUserFromRequest(request).catch(() => null)

    const settings = await prisma.settings.findUnique({
      where: orgSettingsWhere(),
      select: {
        defaultTheme: true,
        accentColor: true,
        brandingLogoPath: true,
        // 5.6.1: the sidebar lockup renders the company name next to the
        // brand icon — see AdminSidebar.
        companyName: true,
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
      companyName: settings?.companyName || null,
      appDomain: settings?.appDomain || null,
      // 6.0.3: ALWAYS hand the client a public origin to mint share links
      // against. Before this, an unset `appDomain` meant the admin UI fell
      // back to `window.location.origin` — an IP when browsing over LAN or
      // the TrueNAS portal, which produced share links no client could open.
      shareOrigin: settings?.appDomain?.trim() || canonicalPublicOrigin(),
    })
  } catch (error) {
    // Default values on error
    return NextResponse.json({ defaultTheme: 'dark', accentColor: 'blue', brandingLogoPath: null, companyName: null, appDomain: null, shareOrigin: canonicalPublicOrigin() })
  }
}
