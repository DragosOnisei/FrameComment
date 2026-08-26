'use client'

import { Globe, Monitor, Smartphone } from 'lucide-react'

/**
 * 7.3.1 — the browser and the machine a report came from, as a picture.
 *
 * The inbox used to print the raw signature next to the page URL — `chrome:macos`
 * followed by a hundred characters of admin link, which is the shape of a log
 * line rather than of something you read forty times a day. The value it carries
 * is worth two glyphs and two short words: which browser, and whether the person
 * was at a desk or on a phone. That is what a bug report is triaged by.
 *
 * The string comes from `deviceSignature()` in src/lib/device-signature.ts and
 * is deliberately coarse — `browser:platform`, every version number stripped,
 * for reasons that file explains at length. Anything this parser does not
 * recognise falls back to a plain globe and the word "Browser" rather than
 * guessing, because a wrong badge is worse than an unspecific one: it would
 * send me looking at the wrong browser.
 *
 * WHY THE MARKS ARE DRAWN HERE
 *
 * lucide-react carries no brand icons — it dropped them, and `Chrome` no longer
 * exists in 0.563. The three that are simple, unambiguous geometry are drawn
 * inline: Chrome is three equal arcs around a blue centre, Safari is a compass
 * (which is exactly what its logo is), Opera is a red O. Firefox and Edge are
 * neither simple nor unambiguous, and a bad freehand version of a logo reads as
 * a mistake, so they get the shared globe tinted with the brand colour instead.
 * Honest and plain beats a wonky drawing.
 */

type Browser = 'chrome' | 'safari' | 'firefox' | 'edge' | 'opera' | 'other'
type Platform = 'macos' | 'ios' | 'windows' | 'android' | 'linux' | 'chromeos' | 'other'

const BROWSER_LABEL: Record<Browser, string> = {
  chrome: 'Chrome',
  safari: 'Safari',
  firefox: 'Firefox',
  edge: 'Edge',
  opera: 'Opera',
  other: 'Browser',
}

const PLATFORM_LABEL: Record<Platform, string> = {
  macos: 'macOS',
  ios: 'iOS',
  windows: 'Windows',
  android: 'Android',
  linux: 'Linux',
  chromeos: 'ChromeOS',
  other: 'Unknown',
}

/** iOS and Android are the only two that are certainly not a desk. */
const HANDHELD: Platform[] = ['ios', 'android']

export function parseClient(client: string | null | undefined): {
  browser: Browser
  platform: Platform
} {
  const [b, p] = (client || '').toLowerCase().split(':')
  const browser = (['chrome', 'safari', 'firefox', 'edge', 'opera'] as const).find((x) => x === b)
  const platform = (
    ['macos', 'ios', 'windows', 'android', 'linux', 'chromeos'] as const
  ).find((x) => x === p)
  return { browser: browser || 'other', platform: platform || 'other' }
}

function BrowserMark({ browser, className }: { browser: Browser; className?: string }) {
  const common = { className, viewBox: '0 0 24 24', 'aria-hidden': true } as const

  if (browser === 'chrome') {
    // Three 120° wedges split at 90° (down), 210° and 330°, so red sits over
    // the top and green/yellow divide the bottom — the arrangement of the real
    // mark. The white ring and blue centre are drawn over the join.
    return (
      <svg {...common}>
        <path d="M12 12 L2.47 6.5 A11 11 0 0 1 21.53 6.5 Z" fill="#EA4335" />
        <path d="M12 12 L21.53 6.5 A11 11 0 0 1 12 23 Z" fill="#FBBC05" />
        <path d="M12 12 L12 23 A11 11 0 0 1 2.47 6.5 Z" fill="#34A853" />
        <circle cx="12" cy="12" r="5.6" fill="#fff" />
        <circle cx="12" cy="12" r="4.6" fill="#4285F4" />
      </svg>
    )
  }

  if (browser === 'safari') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="10.6" fill="#25A8F0" />
        <circle cx="12" cy="12" r="8.7" fill="#0B7FD4" />
        <path d="M16.8 7.2 L10.7 10.7 L7.2 16.8 L13.3 13.3 Z" fill="#fff" />
        <path d="M16.8 7.2 L10.7 10.7 L13.3 13.3 Z" fill="#FF3B30" />
      </svg>
    )
  }

  if (browser === 'opera') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="10.6" fill="#FF1B2D" />
        <ellipse cx="12" cy="12" rx="4.1" ry="7.7" fill="#fff" />
      </svg>
    )
  }

  // Firefox, Edge and anything unrecognised: the shared glyph, tinted.
  const tint =
    browser === 'firefox' ? '#FF7139' : browser === 'edge' ? '#2FA5D6' : undefined
  return <Globe className={className} style={tint ? { color: tint } : undefined} aria-hidden />
}

/**
 * One row: which browser, and what it was running on. Rendered as plain text
 * beside each glyph, because "Chrome" is shorter to read than a logo is to
 * recognise at 14 pixels and the two together are unambiguous.
 */
export default function ClientBadge({
  client,
  className,
}: {
  client: string | null | undefined
  className?: string
}) {
  if (!client) return null
  const { browser, platform } = parseClient(client)
  const DeviceIcon = HANDHELD.includes(platform) ? Smartphone : Monitor

  return (
    <span className={className}>
      <span className="inline-flex items-center gap-1.5">
        <BrowserMark browser={browser} className="h-3.5 w-3.5 shrink-0" />
        {BROWSER_LABEL[browser]}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <DeviceIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {PLATFORM_LABEL[platform]}
      </span>
    </span>
  )
}
