import { prisma } from '@/lib/db'

type AccentKey =
  | 'blue'
  | 'purple'
  | 'green'
  | 'orange'
  | 'red'
  | 'pink'
  | 'teal'
  | 'amber'
  | 'stone'
  | 'gold'

const accentPalette: Record<AccentKey, string> = {
  blue: 'hsl(211 100% 50%)',
  purple: 'hsl(262 83% 58%)',
  green: 'hsl(145 63% 42%)',
  orange: 'hsl(25 95% 53%)',
  red: 'hsl(0 84% 60%)',
  pink: 'hsl(330 81% 60%)',
  teal: 'hsl(173 80% 40%)',
  amber: 'hsl(38 92% 50%)',
  stone: 'hsl(30 12% 50%)',
  gold: 'hsl(37 56% 65%)',
}

export async function getAccentColor(): Promise<string> {
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: { accentColor: true },
    })
    const accentKey = (settings?.accentColor as AccentKey | undefined) || 'blue'
    return accentPalette[accentKey] || accentPalette.blue
  } catch {
    return accentPalette.blue
  }
}

/**
 * 2.5.0+ FrameComment logomark (server-side builder).
 *
 * Returns a self-contained SVG string for the play+i wordmark.
 * Mirrors the React `<LogoMark />` component pixel-for-pixel so
 * the static favicon / PWA / Apple-touch routes look identical
 * to the in-app render. Embeds a tiny <style> block with a
 * prefers-color-scheme rule so:
 *   - Light browsers / OS → white tile, dark stem
 *   - Dark browsers / OS → near-black tile, white stem
 * The blue accent stays the same in both modes (it's tuned to be
 * readable on either background).
 *
 * `accentColor` lets the user's chosen Settings accent theme the
 * play triangle + i-dot — defaulting to blue when the call site
 * doesn't override.
 */
export function buildLogoSvg(accentColor: string, size: number): string {
  // 3.2.0+: dropped the rounded-square background. The Play + i marks
  // sit on a transparent surface so browser tabs, OS launchers, and
  // PWA contexts render them on their own theme chrome instead of a
  // hard-edged white/black square. i-stem still flips colour with
  // prefers-color-scheme so it stays legible on both light + dark.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
  <style>
    :root { --logo-i-stem: #0f172a; }
    @media (prefers-color-scheme: dark) {
      :root { --logo-i-stem: #f5f7fb; }
    }
  </style>
  <path d="M 14 16 C 14 13 16 12 18 13 L 41 30 C 43 31 43 33 41 34 L 18 51 C 16 52 14 51 14 48 Z" fill="${accentColor}"/>
  <circle cx="51" cy="20" r="4.5" fill="${accentColor}"/>
  <rect x="46.5" y="28" width="9" height="22" rx="4.5" fill="var(--logo-i-stem)"/>
</svg>`
}
