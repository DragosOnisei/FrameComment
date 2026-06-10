'use client'

import { Check, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

interface PasswordRequirementsProps {
  password: string
  className?: string
}

export function PasswordRequirements({ password, className = '' }: PasswordRequirementsProps) {
  const t = useTranslations('auth')

  const results = [
    {
      label: t('passwordMinChars'),
      passed: password.length >= 12,
    },
    {
      label: t('passwordUppercase'),
      passed: /[A-Z]/.test(password),
    },
    {
      label: t('passwordLowercase'),
      passed: /[a-z]/.test(password),
    },
    {
      label: t('passwordNumber'),
      passed: /[0-9]/.test(password),
    },
    {
      label: t('passwordSpecial'),
      passed: /[^A-Za-z0-9]/.test(password),
    },
  ]

  const allPassed = results.every((r) => r.passed)

  return (
    // 2.5.1+ glass refresh — sits inside Add User / Edit User
    // dialogs that now use the white-on-glass palette. The active
    // (passed) state stays on `text-success` so the green check
    // reads as a positive confirmation; the inactive state shifts
    // to `text-white/55` for legibility against the frosted shell.
    <div className={`space-y-2 ${className}`}>
      <p className="text-sm font-semibold text-white">{t('passwordRequirements')}</p>
      <ul className="space-y-1">
        {results.map((result, index) => (
          <li
            key={index}
            className={`flex items-center gap-2 text-sm transition-colors ${
              result.passed ? 'text-success' : 'text-white/55'
            }`}
          >
            {result.passed ? (
              <Check className="w-4 h-4 flex-shrink-0" />
            ) : (
              <X className="w-4 h-4 flex-shrink-0 text-white/35" />
            )}
            <span className={result.passed ? 'font-medium' : ''}>{result.label}</span>
          </li>
        ))}
      </ul>
      {allPassed && password.length > 0 && (
        <p className="text-sm text-success font-medium mt-2 flex items-center gap-1">
          <Check className="w-4 h-4" /> {t('passwordMeetsAll')}
        </p>
      )}
    </div>
  )
}
