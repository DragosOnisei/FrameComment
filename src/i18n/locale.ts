import { orgSettingsWhere, settingsReadClient, currentOrgId } from '@/lib/db'

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
// 5.5 multi-tenant: keyed per organization — a global slot would serve one
// company's language to another for up to the TTL window.
const localeCache = new Map<string, { value: string; expiresAt: number }>()
const LOCALE_CACHE_TTL_MS = 60_000

export async function getConfiguredLocale(): Promise<string> {
  const now = Date.now()
  const key = currentOrgId()
  const cached = localeCache.get(key)
  if (cached && cached.expiresAt > now) return cached.value
  try {
    // settingsReadClient: called on public/pre-auth paths too (login, share).
    const settings = await settingsReadClient().settings.findUnique({
      where: orgSettingsWhere(),
      select: { language: true },
    })
    const value = settings?.language || 'en'
    localeCache.set(key, { value, expiresAt: now + LOCALE_CACHE_TTL_MS })
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

