'use client'

/**
 * 6.15.2 — the app's own recovery screen for an uncaught render error.
 *
 * Until now there was no `error.tsx` anywhere in the tree, so any exception
 * thrown while rendering fell all the way through to Next's built-in page:
 * a bare "This page couldn't load" on a white-ish slab, outside our layout,
 * with no styling, no navigation, and — the part that actually costs us — no
 * indication of WHAT went wrong. A user hitting it can only tell us "it broke",
 * and we get to guess.
 *
 * This keeps the person inside the app, gives them two real ways out, and
 * shows the error message plus Next's `digest` so a bug report carries the one
 * detail that makes it reproducible. The message is not hidden behind an env
 * check: this is a tool people use with their own footage on their own server,
 * and "Cannot read properties of null (reading 'name')" is more respectful of
 * their time than a shrug. Stack traces stay in the console.
 */

import { useEffect } from 'react'
import { AlertTriangle, RotateCw, ArrowLeft } from 'lucide-react'

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Next already logs this server-side; this puts it in the browser console
    // too, where the person who hit it can copy it.
    console.error('[FrameComment] Unhandled render error:', error)
  }, [error])

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-6 py-16">
      <div
        className="w-full max-w-md rounded-2xl ring-1 ring-white/12 p-6 text-white shadow-[0_24px_60px_-12px_rgba(0,0,0,0.7)]"
        style={{
          backgroundColor: 'rgba(22, 37, 51, 0.62)',
          backgroundImage:
            'radial-gradient(140% 80% at 0% 0%, hsl(var(--spotlight-tint) / 0.22) 0%, hsl(var(--spotlight-tint) / 0.06) 45%, transparent 75%)',
          backdropFilter: 'blur(40px) saturate(180%)',
          WebkitBackdropFilter: 'blur(40px) saturate(180%)',
        }}
      >
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-amber-400/15 ring-1 ring-amber-300/30">
          <AlertTriangle className="w-4.5 h-4.5 text-amber-300" />
        </span>

        <h1 className="mt-4 text-lg font-semibold">Something broke on this screen</h1>
        <p className="mt-1.5 text-sm text-white/55 leading-relaxed">
          The rest of the app is fine — your files and comments are untouched.
          Try again, or step back to where you were.
        </p>

        {(error?.message || error?.digest) && (
          <div className="mt-4 rounded-lg bg-black/30 ring-1 ring-white/10 p-3">
            {error.message && (
              <p className="text-[11px] font-mono text-white/70 break-words leading-relaxed">
                {error.message}
              </p>
            )}
            {error.digest && (
              <p className="mt-1.5 text-[10px] font-mono text-white/35">
                digest {error.digest}
              </p>
            )}
          </div>
        )}

        <div className="mt-5 flex items-center gap-2">
          <button
            type="button"
            onClick={() => reset()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-xs font-semibold text-primary-foreground hover:brightness-110 transition-[filter]"
          >
            <RotateCw className="w-3.5 h-3.5" />
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.history.back()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-xs font-medium text-white/80 bg-white/[0.06] hover:bg-white/[0.12] hover:text-white ring-1 ring-white/15 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Go back
          </button>
        </div>
      </div>
    </div>
  )
}
