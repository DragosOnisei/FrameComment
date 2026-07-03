import { prisma } from '@/lib/db'

export const SUPPORTED_LOCALES = ['en'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

export const LOCALE_NAMES: Record<string, string> = {
  en: 'English',
}

// 3.8.x PERF: in-memory cache for the configured locale. This function
// is called at the TOP of nearly every API route (to localise error
// messages), including the video content route which runs on EVERY
// range request while streaming/scrubbing. Hitting the DB each time was
// a needless query on the hottest path. The language setting changes
// almost never, so a short TTL is plenty — a change propagates within
// CACHE_TTL_MS across the process.
let localeCache: { value: string; expiresAt: number } | null = null
const LOCALE_CACHE_TTL_MS = 60_000

export async function getConfiguredLocale(): Promise<string> {
  const now = Date.now()
  if (localeCache && localeCache.expiresAt > now) return localeCache.value
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: { language: true },
    })
    const value = settings?.language || 'en'
    localeCache = { value, expiresAt: now + LOCALE_CACHE_TTL_MS }
    return value
  } catch {
    return 'en'
  }
}

/**
 * Load locale messages for server-side use (e.g., email templates).
 * Returns the full messages object for the given locale.
 */
export async function loadLocaleMessages(locale: string): Promise<Record<string, any>> {
  try {
    return (await import(`../locales/${locale}.json`)).default
  } catch {
    return (await import('../locales/en.json')).default
  }
}

