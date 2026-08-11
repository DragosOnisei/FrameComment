'use client'

/**
 * 6.2.0 — shared page frame for the Founder area: topbar + padded content, so
 * Dashboard / CRM / AI Agents stay visually identical to each other and to the
 * app's own pages.
 *
 * `EmptySection` is the honest placeholder used while a section has no data
 * (or isn't built yet): it says what will be there instead of showing invented
 * numbers.
 */

import type { ReactNode } from 'react'
import FounderTopBar from '@/components/founder/FounderTopBar'

export function FounderPage({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: ReactNode
}) {
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <FounderTopBar title={title} />
      <div className="px-4 md:px-6 pb-10">
        {subtitle && <p className="text-sm text-muted-foreground mb-4">{subtitle}</p>}
        {children}
      </div>
    </div>
  )
}

/** A titled card. Same glass vocabulary as the rest of the app. */
export function FounderCard({
  title,
  action,
  children,
  className = '',
}: {
  title?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={`rounded-xl bg-white/[0.04] ring-1 ring-white/10 p-4 sm:p-5 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] ${className}`}
    >
      {(title || action) && (
        <div className="flex items-center justify-between gap-3 mb-3">
          {title && <h2 className="text-sm font-semibold text-foreground/90">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

/**
 * A metric tile. `value` is intentionally `string | null`: null renders an em
 * dash, so a section that has no data yet reads as "nothing measured" rather
 * than a confident zero.
 */
export function MetricTile({
  label,
  value,
  hint,
}: {
  label: string
  value: string | null
  hint?: string
}) {
  return (
    <div className="rounded-xl bg-white/[0.04] ring-1 ring-white/10 p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums">
        {value ?? <span className="text-foreground/30">—</span>}
      </p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** Honest empty state: what lands here, and when. */
export function EmptySection({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="rounded-xl bg-white/[0.03] ring-1 ring-white/10 border-dashed p-6 text-center">
      <p className="text-sm font-medium text-foreground/85">{title}</p>
      <p className="mt-1.5 text-sm text-muted-foreground max-w-lg mx-auto">{description}</p>
    </div>
  )
}
