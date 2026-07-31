'use client'

/**
 * 4.7.x: admin topbar Sort menu (desktop only). A single icon button that
 * opens a small dropdown letting the user order the folder/video grid by:
 *   - Name        A → Z  /  Z → A
 *   - Upload date Newest → Oldest  /  Oldest → Newest
 *
 * The choice is the shared per-user `useAdminSortMode` preference, so it
 * carries across the projects dashboard, a project's root, and nested
 * folders. FolderBrowser consumes the live value and reorders accordingly.
 */

import { useEffect, useRef, useState } from 'react'
import { ArrowDownUp, Check } from 'lucide-react'
import { useAdminSortMode, type AdminSortMode } from '@/lib/use-admin-sort-mode'

const SECTIONS: { group: string; items: { mode: AdminSortMode; label: string }[] }[] = [
  {
    group: 'Name',
    items: [
      { mode: 'alphabetical', label: 'A → Z' },
      { mode: 'alphabetical-reverse', label: 'Z → A' },
    ],
  },
  {
    group: 'Upload date',
    items: [
      { mode: 'date-newest', label: 'Newest → Oldest' },
      { mode: 'date-oldest', label: 'Oldest → Newest' },
    ],
  },
]

export default function SortModeMenu() {
  const [mode, setMode] = useAdminSortMode()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Sort"
        title="Sort"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`inline-flex items-center justify-center h-9 w-9 rounded-lg bg-white/[0.06] ring-1 ring-white/10 hover:bg-white/[0.12] hover:ring-white/20 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] transition-colors text-white/70 hover:text-white ${
          open ? 'bg-white/[0.12] ring-white/20 text-white' : ''
        }`}
      >
        <ArrowDownUp className="w-4 h-4" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-2 w-56 rounded-xl overflow-hidden ring-1 ring-white/10 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.7)] text-white z-[100] bg-background"
          // Opaque accent-tinted surface (inline color-mix) matching the
          // notification + account menus — no see-through glass.
          style={{
            backgroundColor:
              'color-mix(in srgb, hsl(var(--spotlight-tint)) 18%, hsl(var(--background)))',
          }}
        >
          {SECTIONS.map((section, si) => (
            <div key={section.group} className={si > 0 ? 'border-t border-white/10' : ''}>
              <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-white/40">
                {section.group}
              </div>
              {section.items.map((item) => {
                const active = mode === item.mode
                return (
                  <button
                    key={item.mode}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    onClick={() => {
                      setMode(item.mode)
                      setOpen(false)
                    }}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                      active
                        ? 'text-white bg-white/[0.08]'
                        : 'text-white/75 hover:text-white hover:bg-white/[0.06]'
                    }`}
                  >
                    <span className="w-4 shrink-0 flex items-center justify-center">
                      {active && <Check className="w-3.5 h-3.5 text-primary" />}
                    </span>
                    <span className="flex-1">{item.label}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
