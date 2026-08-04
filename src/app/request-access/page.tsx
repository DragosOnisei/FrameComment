'use client'

/**
 * 5.14, /request-access: the landing page's "Request early access" form.
 *
 * Collects name, email and profession and delivers them as an in-app
 * notification to the platform owner (no outbound email system yet).
 * Same glass visual system as the rest of the public site; all links
 * relative so localhost and framecomment.com behave identically.
 */

import { useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Check, Loader2, Send } from 'lucide-react'
import { MarketingNav } from '@/components/marketing/MarketingNav'
import { MarketingFooter } from '@/components/marketing/MarketingFooter'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'

const PROFESSIONS = ['Editor', 'Director', 'YouTuber', 'Entrepreneur', 'Other'] as const

export default function RequestAccessPage() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [profession, setProfession] = useState<string>('')
  const [professionOther, setProfessionOther] = useState('')
  // Honeypot, hidden from humans, tempting for bots.
  const [company, setCompany] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setError('')
    if (!profession) {
      setError('Please pick the option that describes you best.')
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/early-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, profession, professionOther, company }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data?.error || 'Something went wrong. Please try again.')
        return
      }
      setDone(true)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative min-h-screen bg-background text-foreground flex flex-col">
      {/* Aurora at the PAGE root so it glows through the transparent nav. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[34rem] overflow-hidden">
        <div className="fc-aurora absolute -top-32 left-1/2 -translate-x-1/2 h-[28rem] w-[28rem] rounded-full bg-primary/15 blur-3xl" />
      </div>

      <MarketingNav />

      <main className="relative flex-1">
        <div className="relative mx-auto max-w-lg px-4 sm:px-6 py-16">
          <div className="text-center mb-8">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary mb-3">
              Private beta
            </p>
            <h1 className="text-3xl sm:text-4xl font-bold text-white leading-tight">
              Request early access
            </h1>
            <p className="mt-3 text-white/60">
              Tell us who you are and we&apos;ll send you an invite as spots
              open up.
            </p>
          </div>

          <div className="rounded-2xl bg-white/[0.04] ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] p-6 sm:p-8">
            {done ? (
              <div className="text-center py-6">
                <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/40">
                  <Check className="w-6 h-6 text-emerald-300" />
                </span>
                <h2 className="mt-5 text-xl font-semibold text-white">Request received</h2>
                <p className="mt-2 text-sm text-white/60">
                  Thanks, {name.split(' ')[0] || 'friend'}. We review every
                  request personally and will reach out at {email} with your
                  invite.
                </p>
                <Link
                  href="/"
                  className="mt-6 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                >
                  Back to the site <ArrowRight className="w-4 h-4" />
                </Link>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-5">
                {error && (
                  <div className="rounded-lg bg-red-500/10 ring-1 ring-red-500/30 text-red-200 text-sm px-3 py-2">
                    {error}
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="ra-name" className="text-white/85">Name</Label>
                  <Input
                    id="ra-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    maxLength={120}
                    placeholder="Your name"
                    className="bg-white/[0.04] border-white/10 text-white placeholder:text-white/35"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="ra-email" className="text-white/85">Email</Label>
                  <Input
                    id="ra-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    maxLength={254}
                    placeholder="you@studio.com"
                    className="bg-white/[0.04] border-white/10 text-white placeholder:text-white/35"
                  />
                </div>

                {/* Honeypot, visually hidden, real users never see it.
                    Inline styles (not utility classes) so it can never
                    surface, iOS Safari rendered the class-based version. */}
                <div
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    left: '-9999px',
                    width: '1px',
                    height: '1px',
                    overflow: 'hidden',
                    pointerEvents: 'none',
                    opacity: 0,
                  }}
                >
                  <label htmlFor="ra-company">Company</label>
                  <input
                    id="ra-company"
                    type="text"
                    tabIndex={-1}
                    autoComplete="off"
                    value={company}
                    onChange={(e) => setCompany(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-white/85">What describes you best?</Label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {PROFESSIONS.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setProfession(p)}
                        className={
                          'h-10 rounded-lg text-sm ring-1 transition-colors ' +
                          (profession === p
                            ? 'bg-primary/20 ring-primary/50 text-white'
                            : 'bg-white/[0.04] ring-white/10 text-white/65 hover:bg-white/[0.08]')
                        }
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                  {profession === 'Other' && (
                    <Input
                      value={professionOther}
                      onChange={(e) => setProfessionOther(e.target.value)}
                      maxLength={120}
                      placeholder="Tell us what you do"
                      className="mt-2 bg-white/[0.04] border-white/10 text-white placeholder:text-white/35"
                    />
                  )}
                </div>

                <Button
                  type="submit"
                  disabled={busy}
                  className="w-full h-11 text-base font-semibold"
                >
                  {busy ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4 mr-2" />
                  )}
                  Send request
                </Button>

                <p className="text-[11px] text-white/40 text-center">
                  Already have an invite code?{' '}
                  <Link href="/register" className="text-primary hover:underline">
                    Create your company
                  </Link>
                </p>
              </form>
            )}
          </div>
        </div>
      </main>

      <MarketingFooter />
    </div>
  )
}
