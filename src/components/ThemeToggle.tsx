'use client'

import { Moon, Sun } from 'lucide-react'
import { useEffect, useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'

export default function ThemeToggle() {
  const t = useTranslations('controls')
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const [mounted, setMounted] = useState(false)

  const applyTheme = (themeToApply: 'light' | 'dark') => {
    if (themeToApply === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }

  const fetchAndApplyDefaultTheme = useCallback(async () => {
    try {
      // Check if we already have a cached admin default
      const cachedDefault = localStorage.getItem('adminDefaultTheme')

      // Fetch the current admin default
      const response = await fetch('/api/settings/theme')
      if (response.ok) {
        const data = await response.json()
        const adminDefault = data.defaultTheme || 'auto'

        // Cache the admin default for future page loads
        localStorage.setItem('adminDefaultTheme', adminDefault)

        // 3.6.x: default is dark. Anything that isn't an explicit
        // 'light' (including legacy 'auto') resolves to dark, so a
        // light-mode OS never forces the app to light.
        const themeToUse: 'light' | 'dark' = adminDefault === 'light' ? 'light' : 'dark'
        setTheme(themeToUse)
        applyTheme(themeToUse)
      } else if (cachedDefault) {
        // API failed, use cached default (same dark-default rule).
        const themeToUse: 'light' | 'dark' = cachedDefault === 'light' ? 'light' : 'dark'
        setTheme(themeToUse)
        applyTheme(themeToUse)
      } else {
        // No cached default and API failed — default to dark.
        setTheme('dark')
        applyTheme('dark')
      }
    } catch {
      // On error, default to dark.
      setTheme('dark')
      applyTheme('dark')
    }
  }, [])

  useEffect(() => {
    setMounted(true)

    // Check if user has a saved preference
    const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' | null

    if (savedTheme) {
      // User has manually set a preference - use it
      setTheme(savedTheme)
      applyTheme(savedTheme)
    } else {
      // No saved preference - fetch admin default and apply
      fetchAndApplyDefaultTheme()
    }
    // 3.6.x: no longer follow the OS `prefers-color-scheme`. The app is
    // dark-by-default and 'auto' resolves to dark, so tracking the OS
    // (which used to flip a light-mode laptop to light) is gone.
  }, [fetchAndApplyDefaultTheme])

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light'
    setTheme(newTheme)
    // Save user's manual preference
    localStorage.setItem('theme', newTheme)

    // Apply/remove dark class properly
    if (newTheme === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }

  // Avoid hydration mismatch
  if (!mounted) {
    return (
      <button
        className="p-2 rounded-lg border border-border bg-background hover:bg-accent transition-colors shadow-sm"
        aria-label={t('toggleTheme')}
      >
        <div className="h-5 w-5" />
      </button>
    )
  }

  return (
    <button
      onClick={toggleTheme}
      className="p-2 rounded-lg border border-border bg-background hover:bg-accent transition-colors shadow-sm"
      aria-label={t('toggleTheme')}
      title={theme === 'light' ? t('switchToDark') : t('switchToLight')}
    >
      {theme === 'light' ? (
        <Moon className="h-5 w-5 text-foreground" />
      ) : (
        <Sun className="h-5 w-5 text-foreground" />
      )}
    </button>
  )
}
