'use client'

/**
 * 5.14.0, FrameComment public landing page.
 *
 * Design goals:
 *  - Same visual system as the app (dark navy, glass cards, accent blue,
 *    spotlight gradients) so signing in feels like walking through a door,
 *    not into a different product.
 *  - Frame.io ENERGY without copying it: hero → pillars → deep dives →
 *    security → honest pricing → about → CTA. No fake customer logos, no
 *    invented stats, no social icons, we don't have them, so they're
 *    not here.
 *  - All links RELATIVE (works on localhost and framecomment.com alike).
 *  - Animations are pure CSS (globals.css `fc-*` helpers) + one small
 *    IntersectionObserver for scroll reveals; everything respects
 *    prefers-reduced-motion.
 *
 * Signed-in visitors are quietly redirected into the app, the landing
 * is for people who don't have the door key yet.
 */

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowRight,
  MessageSquare,
  Share2,
  Layers,
  FolderTree,
  Mic,
  FileText,
  Paperclip,
  Lock,
  Timer,
  ThumbsUp,
  UploadCloud,
  HardDrive,
  Server,
  Cloud,
  Database,
  ShieldCheck,
  KeyRound,
  Trash2,
  Users,
  Check,
  Play,
  GitCompare,
  Smartphone,
  Zap,
} from 'lucide-react'
import { MarketingNav } from './MarketingNav'
import { MarketingFooter } from './MarketingFooter'
import { apiFetch } from '@/lib/api-client'

/* ── tiny building blocks ──────────────────────────────────────────── */

function Glass({
  className = '',
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={
        'rounded-2xl bg-white/[0.04] ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] ' +
        className
      }
    >
      {children}
    </div>
  )
}

function SectionHeading({
  eyebrow,
  title,
  sub,
}: {
  eyebrow: string
  title: React.ReactNode
  sub?: string
}) {
  return (
    <div className="fc-reveal max-w-2xl">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary mb-3">
        {eyebrow}
      </p>
      <h2 className="text-3xl sm:text-4xl font-bold text-white leading-tight">
        {title}
      </h2>
      {sub && <p className="mt-4 text-white/60 text-lg leading-relaxed">{sub}</p>}
    </div>
  )
}

function Bullet({
  icon: Icon,
  title,
  text,
}: {
  icon: any
  title: string
  text: string
}) {
  return (
    <div className="fc-reveal flex items-start gap-3.5">
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/25">
        <Icon className="w-4.5 h-4.5" />
      </span>
      <div>
        <p className="text-sm font-semibold text-white">{title}</p>
        <p className="text-sm text-white/55 mt-1 leading-relaxed">{text}</p>
      </div>
    </div>
  )
}

/* ── stylized product mocks (CSS-built, honest depictions) ─────────── */

function HeroMock() {
  return (
    <div className="relative mx-auto max-w-3xl">
      {/* Player card */}
      <Glass className="relative overflow-hidden p-3 sm:p-4">
        <div className="relative aspect-video rounded-xl overflow-hidden bg-gradient-to-br from-[#12314f] via-[#0d1b2a] to-[#1a1030]">
          {/* faux footage glow */}
          <div className="absolute -top-1/4 -left-1/4 w-2/3 h-2/3 rounded-full bg-primary/25 blur-3xl fc-aurora" />
          <div className="absolute -bottom-1/3 -right-1/4 w-2/3 h-2/3 rounded-full bg-indigo-500/20 blur-3xl fc-aurora-slow" />
          {/* play button */}
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/25 backdrop-blur-md">
              <Play className="w-6 h-6 text-white translate-x-0.5" />
            </span>
          </div>
          {/* version chip */}
          <span className="absolute top-3 right-3 px-2 py-1 rounded-md text-[11px] font-semibold bg-primary text-primary-foreground">
            v3
          </span>
          {/* approved chip */}
          <span className="absolute top-3 left-3 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40">
            <Check className="w-3 h-3" /> Approved by client
          </span>
        </div>
        {/* timeline with comment markers */}
        <div className="mt-3 px-1">
          <div className="relative h-2 rounded-full bg-white/10">
            <div className="absolute left-0 top-0 h-full w-[62%] rounded-full bg-primary/80" />
            {[14, 31, 47, 62, 81].map((pct, i) => (
              <span
                key={pct}
                className={
                  'absolute -top-[3px] h-3.5 w-3.5 rounded-full ring-2 ring-[#0d1420] ' +
                  ['bg-amber-400', 'bg-primary', 'bg-rose-400', 'bg-emerald-400', 'bg-violet-400'][i]
                }
                style={{ left: `${pct}%` }}
              />
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between text-[10px] text-white/55 tabular-nums">
            <span>00:41:12</span>
            <span>01:06:00</span>
          </div>
        </div>
      </Glass>

      {/* floating comment card */}
      <Glass className="fc-float absolute -left-4 sm:-left-16 top-8 hidden md:block w-56 sm:w-64 p-3 backdrop-blur-xl">
        <div className="flex items-center gap-2">
          <span className="fc-ping h-2 w-2 rounded-full bg-primary" />
          <span className="text-[11px] font-semibold text-white">Client · 00:41</span>
        </div>
        <p className="mt-1.5 text-xs text-white/70 leading-relaxed">
          Love this cut, can the logo hold 10 more frames?
        </p>
        <div className="mt-2 inline-flex items-center gap-1 text-[10px] text-emerald-300">
          <Check className="w-3 h-3" /> Frame-accurate
        </div>
      </Glass>

      {/* floating versions card */}
      <Glass className="fc-float-2 absolute -right-4 sm:-right-14 -bottom-8 hidden md:block w-48 sm:w-56 p-3 backdrop-blur-xl">
        <p className="text-[11px] font-semibold text-white mb-2">Versions</p>
        <div className="space-y-1.5">
          {['v3, current', 'v2', 'v1'].map((v, i) => (
            <div
              key={v}
              className={
                'flex items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] ' +
                (i === 0
                  ? 'bg-primary/20 text-white ring-1 ring-primary/40'
                  : 'bg-white/[0.04] text-white/55')
              }
            >
              <Layers className="w-3 h-3 shrink-0" />
              {v}
            </div>
          ))}
        </div>
      </Glass>
    </div>
  )
}

function ReviewMock() {
  return (
    <Glass className="p-4 space-y-3">
      {[
        { who: 'Maria (Client)', at: '00:12', text: 'Swap this b-roll, feels off-brand.', tone: 'bg-amber-400' },
        { who: 'Andrei (Editor)', at: '00:12', text: 'On it. New take uploading as v4.', tone: 'bg-primary' },
        { who: 'Maria (Client)', at: '01:03', text: '🎤 Voice note, 0:22', tone: 'bg-rose-400', voice: true },
      ].map((c) => (
        <div key={c.who + c.at} className="flex items-start gap-3">
          <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${c.tone}`} />
          <div className="min-w-0 flex-1 rounded-xl bg-white/[0.05] ring-1 ring-white/10 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-white truncate">{c.who}</span>
              <span className="text-[10px] text-primary font-mono shrink-0">{c.at}</span>
            </div>
            <p className="mt-0.5 text-xs text-white/65 flex items-center gap-1.5">
              {c.voice && <Mic className="w-3 h-3 text-rose-300 shrink-0" />}
              {c.text}
            </p>
          </div>
        </div>
      ))}
      <div className="flex items-center gap-2 rounded-xl bg-white/[0.03] ring-1 ring-white/10 px-3 py-2.5 text-xs text-white/55">
        Leave your comment at 01:14…
        <span className="ml-auto inline-flex items-center gap-2 text-white/50">
          <Mic className="w-3.5 h-3.5" />
          <Paperclip className="w-3.5 h-3.5" />
        </span>
      </div>
    </Glass>
  )
}

function ShareMock() {
  return (
    <Glass className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-white">Share with client</p>
        <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30">
          Link active
        </span>
      </div>
      <div className="rounded-xl bg-white/[0.05] ring-1 ring-white/10 px-3 py-2.5 font-mono text-[11px] text-white/60 truncate">
        framecomment.com/s/spring-campaign
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.04] ring-1 ring-white/10 px-2.5 py-2 text-white/65">
          <Lock className="w-3.5 h-3.5 text-primary" /> Password protected
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.04] ring-1 ring-white/10 px-2.5 py-2 text-white/65">
          <Timer className="w-3.5 h-3.5 text-primary" /> Expires in 7 days
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.04] ring-1 ring-white/10 px-2.5 py-2 text-white/65">
          <ThumbsUp className="w-3.5 h-3.5 text-primary" /> Client can approve
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.04] ring-1 ring-white/10 px-2.5 py-2 text-white/65">
          <UploadCloud className="w-3.5 h-3.5 text-primary" /> Client can upload
        </span>
      </div>
      <p className="text-[11px] text-white/55">
        No account needed on the client side, they open the link, watch, and
        comment.
      </p>
    </Glass>
  )
}

function PhoneMock() {
  return (
    <div className="relative mx-auto w-[230px] sm:w-[250px]">
      {/* Phone frame */}
      <div className="rounded-[2.4rem] bg-white/[0.05] ring-1 ring-white/15 p-2 shadow-[0_24px_60px_-16px_rgba(0,0,0,0.8)]">
        <div className="relative rounded-[2rem] overflow-hidden bg-[#0b1220] ring-1 ring-white/10">
          {/* notch */}
          <div className="absolute top-2 left-1/2 -translate-x-1/2 h-5 w-20 rounded-full bg-black/70 z-10" />
          {/* mini player — 9:19.5 = real iPhone proportions, tall not wide */}
          <div className="relative aspect-[9/19.5] flex flex-col">
            <div className="relative flex-1 bg-gradient-to-br from-[#12314f] via-[#0d1b2a] to-[#1a1030]">
              <div className="absolute -top-1/4 -left-1/4 w-2/3 h-2/3 rounded-full bg-primary/25 blur-2xl fc-aurora" />
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/25 backdrop-blur-md">
                  <Play className="w-4 h-4 text-white translate-x-0.5" />
                </span>
              </div>
              <span className="absolute top-9 right-3 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-primary text-primary-foreground">
                v2
              </span>
            </div>
            {/* timeline */}
            <div className="px-3 pt-2.5">
              <div className="relative h-1.5 rounded-full bg-white/10">
                <div className="absolute left-0 top-0 h-full w-[45%] rounded-full bg-primary/80" />
                {[22, 45, 74].map((pct, i) => (
                  <span
                    key={pct}
                    className={
                      'absolute -top-[2px] h-2.5 w-2.5 rounded-full ring-2 ring-[#0b1220] ' +
                      ['bg-amber-400', 'bg-primary', 'bg-emerald-400'][i]
                    }
                    style={{ left: `${pct}%` }}
                  />
                ))}
              </div>
            </div>
            {/* comment + approve */}
            <div className="p-3 space-y-2">
              <div className="rounded-lg bg-white/[0.05] ring-1 ring-white/10 px-2.5 py-1.5">
                <p className="text-[9px] font-semibold text-white">Client · 00:41</p>
                <p className="text-[9px] text-white/60 mt-0.5">Perfect, ship it! 🎉</p>
              </div>
              <div className="flex items-center justify-center gap-1.5 h-8 rounded-lg bg-emerald-500/20 ring-1 ring-emerald-500/40 text-emerald-300 text-[11px] font-semibold">
                <Check className="w-3 h-3" /> Approve
              </div>
            </div>
          </div>
        </div>
      </div>
      {/* floating voice-note chip */}
      <div className="fc-float absolute -right-8 top-1/3 hidden sm:flex items-center gap-1.5 rounded-full bg-white/[0.06] ring-1 ring-white/15 px-3 py-1.5 backdrop-blur-xl">
        <Mic className="w-3.5 h-3.5 text-rose-300" />
        <span className="text-[10px] text-white/70">Voice note · 0:12</span>
      </div>
    </div>
  )
}

function StorageMock() {
  const rows = [
    { icon: Server, label: 'FrameComment Server', note: 'Managed hosting', active: true },
    { icon: HardDrive, label: 'Your own server / NAS', note: 'No per-GB fee' },
    { icon: Cloud, label: 'Cloudflare R2', note: 'Your bucket, your keys' },
    { icon: Database, label: 'AWS S3', note: 'Your bucket, your keys' },
  ]
  return (
    <Glass className="p-4 space-y-2">
      {rows.map((r) => (
        <div
          key={r.label}
          className={
            'flex items-center gap-3 rounded-xl px-3 py-2.5 ring-1 ' +
            (r.active
              ? 'bg-primary/10 ring-primary/30'
              : 'bg-white/[0.04] ring-white/10')
          }
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.06] text-white/75">
            <r.icon className="w-4 h-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-white">{r.label}</p>
            <p className="text-[10px] text-white/55">{r.note}</p>
          </div>
          {r.active && <Check className="w-4 h-4 text-emerald-300 shrink-0" />}
        </div>
      ))}
      <p className="text-[11px] text-white/55 pt-1">
        Switch anytime, files are copied and verified before anything moves.
      </p>
    </Glass>
  )
}

/* ── page ──────────────────────────────────────────────────────────── */

export function LandingClient() {
  const router = useRouter()
  const rootRef = useRef<HTMLDivElement>(null)

  // Signed-in users who land COLD on the root (typed the domain, opened a
  // bookmark) skip the pitch and go straight to their projects. But a
  // signed-in user who deliberately navigated here, via the logo or a
  // Features/Pricing/About link from /terms, /privacy or /login, stays:
  // an anchor in the URL or a same-origin referrer means "show me the
  // landing", not "log me in".
  useEffect(() => {
    if (window.location.hash) return
    try {
      if (document.referrer && document.referrer.startsWith(window.location.origin)) return
    } catch {
      /* referrer unavailable, treat as cold entry */
    }
    let alive = true
    ;(async () => {
      try {
        const res = await apiFetch('/api/auth/session')
        if (!alive) return
        if (res.ok) {
          const data = await res.json().catch(() => null)
          if (data?.authenticated) router.replace('/admin/projects')
        }
      } catch {
        /* logged out or offline, stay on the landing */
      }
    })()
    return () => {
      alive = false
    }
  }, [router])

  // Scroll reveals.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const els = Array.from(root.querySelectorAll<HTMLElement>('.fc-reveal'))
    if (!('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('fc-in'))
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('fc-in')
            io.unobserve(e.target)
          }
        }
      },
      { threshold: 0.15 },
    )
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [])

  const pillars = [
    {
      icon: MessageSquare,
      title: 'Frame-accurate review',
      text: 'Comments pinned to the exact frame, colored timeline markers, voice notes and attachments, feedback that editors can actually act on.',
    },
    {
      icon: Share2,
      title: 'Client-friendly sharing',
      text: 'One link is all your client needs. No accounts, no downloads, they watch, comment and approve right in the browser.',
    },
    {
      icon: Layers,
      title: 'Versions, side by side',
      text: 'Stack v1 → v20 on one card, flip between them instantly, and compare two cuts in a synced side-by-side player.',
    },
    {
      icon: FolderTree,
      title: 'Organized and safe',
      text: 'Projects, folders and search that scale to thousands of clips, with a 30-day Trash and deliberate safety windows before anything is gone.',
    },
  ]

  return (
    <div ref={rootRef} className="relative min-h-screen bg-background text-foreground">
      {/* 5.15 a11y: keyboard/screen-reader users can jump straight past
          the nav. Visually hidden until focused. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-[60] focus:top-3 focus:left-3 focus:px-4 focus:py-2 focus:rounded-lg focus:bg-primary focus:text-primary-foreground focus:text-sm focus:font-semibold"
      >
        Skip to main content
      </a>

      {/* Aurora / light-spot background — lives at the PAGE root (not
          inside the hero) so it also glows through the transparent
          sticky top bar instead of stopping right below it. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[46rem] overflow-hidden">
        <div className="fc-aurora absolute -top-40 left-1/2 -translate-x-[70%] h-[34rem] w-[34rem] rounded-full bg-primary/20 blur-3xl" />
        <div className="fc-aurora-slow absolute -top-20 left-1/2 translate-x-[10%] h-[30rem] w-[30rem] rounded-full bg-indigo-500/15 blur-3xl" />
        <div className="absolute inset-0 bg-[radial-gradient(80%_50%_at_50%_0%,transparent_0%,transparent_60%,hsl(var(--background))_100%)]" />
      </div>

      <MarketingNav onLanding />

      {/* 5.15 a11y: single <main> landmark wrapping all page content. */}
      <main id="main-content">

      {/* ── HERO ─────────────────────────────────────────────────── */}
      <section className="relative">
        <div className="relative mx-auto max-w-6xl px-4 sm:px-6 pt-16 sm:pt-24 pb-16 text-center">
          <div className="fc-reveal fc-in inline-flex items-center gap-2 rounded-full bg-white/[0.05] ring-1 ring-white/15 px-3.5 py-1.5 text-xs text-white/70">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Private beta, access by invite
          </div>

          <h1 className="fc-reveal fc-in mt-6 text-4xl sm:text-6xl font-bold tracking-tight text-white leading-[1.08] max-w-4xl mx-auto">
            Client feedback and video delivery,{' '}
            <span className="fc-gradient-text">finally in one place.</span>
          </h1>

          <p className="fc-reveal fc-in mt-6 text-lg sm:text-xl text-white/60 max-w-2xl mx-auto leading-relaxed">
            FrameComment keeps every cut, comment and approval between your
            production team and your clients organized, so nothing gets lost
            in email threads and WeTransfer links ever again.
          </p>

          {/* 5.14: mobile parity — the two CTAs are full-width, equal
              stacked buttons on phones (same as desktop's visual weight)
              instead of two differently-sized centered pills. */}
          <div className="fc-reveal fc-in mt-8 mx-auto w-full max-w-md sm:max-w-none flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-3">
            <Link
              href="/request-access"
              className="inline-flex h-12 w-full sm:w-auto items-center justify-center gap-2 rounded-xl bg-primary px-6 text-base font-semibold text-primary-foreground hover:brightness-110 transition-[filter]"
            >
              Request early access
              <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="/login"
              className="inline-flex h-12 w-full sm:w-auto items-center justify-center rounded-xl px-6 text-base text-white/80 hover:text-white bg-white/[0.06] hover:bg-white/[0.1] ring-1 ring-white/15 transition-colors"
            >
              Sign in
            </Link>
          </div>

          {/* 5.15 a11y: the mock is a decorative illustration of the
              product — screen readers get the description instead. */}
          <p className="sr-only">
            Illustration of the FrameComment player: a video approved by the
            client, at version 3, with color-coded comments pinned along the
            timeline and a stack of previous versions ready to compare.
          </p>
          <div className="fc-reveal mt-14 sm:mt-20" aria-hidden="true">
            <HeroMock />
          </div>
        </div>
      </section>

      {/* ── PILLARS ──────────────────────────────────────────────── */}
      <section id="features" className="scroll-mt-24 mx-auto max-w-6xl px-4 sm:px-6 py-20">
        <SectionHeading
          eyebrow="Why FrameComment"
          title={
            <>
              Everything between “first cut” and{' '}
              <span className="text-primary">“approved”.</span>
            </>
          }
          sub="Built for YouTubers, agencies and production teams who deliver video to clients, and are tired of chasing feedback across five apps."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {pillars.map((p) => (
            <Glass key={p.title} className="fc-reveal p-5">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/25">
                <p.icon className="w-5 h-5" />
              </span>
              <h3 className="mt-4 text-base font-semibold text-white">{p.title}</h3>
              <p className="mt-2 text-sm text-white/55 leading-relaxed">{p.text}</p>
            </Glass>
          ))}
        </div>
      </section>

      {/* ── ABOUT ────────────────────────────────────────────────── */}
      <section id="about" className="scroll-mt-24 mx-auto max-w-6xl px-4 sm:px-6 py-16">
        <Glass className="fc-reveal relative overflow-hidden p-8 sm:p-12">
          <div aria-hidden className="pointer-events-none absolute -top-24 -right-24 h-72 w-72 rounded-full bg-primary/15 blur-3xl" />
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary mb-3">
            About
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold text-white leading-tight max-w-2xl">
            Built inside a real production workflow, not a pitch deck.
          </h2>
          <div className="mt-6 space-y-4 text-white/60 leading-relaxed max-w-3xl">
            <p>
              FrameComment started as an internal tool for a video production
              team that was drowning in feedback threads: exports in one app,
              comments in another, approvals somewhere in an inbox. We built
              the tool we needed, then kept polishing it every single day,
              because we run our own client work through it, terabytes of it.
            </p>
            <p>
              That&apos;s the whole story. No investor milestones, no fake
              customer walls, no dark patterns.
            </p>
          </div>
        </Glass>
      </section>

      {/* ── STORAGE & PERFORMANCE ────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-4 sm:px-6 py-16 grid gap-10 lg:grid-cols-2 lg:items-center">
        <div className="space-y-8">
          <SectionHeading
            eyebrow="Storage & performance"
            title="Your footage, your storage, your choice."
            sub="Use our managed hosting, or plug in your own NAS, Cloudflare R2 or AWS S3 bucket. Moving between them is a one-click, verified transfer."
          />
          <div className="space-y-5">
            <Bullet
              icon={Play}
              title="Adaptive streaming"
              text="Uploads are encoded into multiple quality tiers up to 4K and stream instantly on any device or connection."
            />
            <Bullet
              icon={HardDrive}
              title="No per-GB fee on your own storage"
              text="Bring your own server or bucket and you only ever pay per member, storage stays yours."
            />
            <Bullet
              icon={ShieldCheck}
              title="Verified transfers"
              text="When you switch backends, every file is copied and size-verified before anything is retired. Nothing is deleted without a confirmed copy."
            />
          </div>
        </div>
        <div className="fc-reveal" aria-hidden="true"><StorageMock /></div>
      </section>

      {/* ── DEEP DIVE 1: REVIEW ──────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-4 sm:px-6 py-16 grid gap-10 lg:grid-cols-2 lg:items-center">
        <div className="space-y-8">
          <SectionHeading
            eyebrow="Review & approval"
            title="Feedback lands on the exact frame."
            sub="Your client clicks the moment, types (or speaks), and the note arrives time-stamped in the editor's queue."
          />
          <div className="space-y-5">
            <Bullet
              icon={MessageSquare}
              title="Timestamped comments & markers"
              text="Every note is pinned to a timecode, with colored timeline markers you can jump between using the keyboard."
            />
            <Bullet
              icon={Mic}
              title="Voice comments"
              text="Sometimes it's easier to say it. Clients can record a voice note right on the frame."
            />
            <Bullet
              icon={FileText}
              title="AI transcripts"
              text="Generate searchable transcripts of your videos as PDFs, ready to share, included in every plan."
            />
            <Bullet
              icon={GitCompare}
              title="Version compare"
              text="Play two versions side by side, perfectly synced, and hear exactly the one you focus on."
            />
          </div>
        </div>
        <div className="fc-reveal" aria-hidden="true"><ReviewMock /></div>
      </section>

      {/* ── DEEP DIVE 2: SHARING ─────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-4 sm:px-6 py-16 grid gap-10 lg:grid-cols-2 lg:items-center">
        <div className="fc-reveal order-2 lg:order-1" aria-hidden="true"><ShareMock /></div>
        <div className="space-y-8 order-1 lg:order-2">
          <SectionHeading
            eyebrow="Sharing & presenting"
            title="Your client's job is one click."
            sub="Send a link that carries your company's name, logo and colors. Everything else, passwords, expiry, download and approval rights, is your call."
          />
          <div className="space-y-5">
            <Bullet
              icon={Lock}
              title="Protected links"
              text="Password-protect shares, set expiration dates, and share a single video or a whole folder."
            />
            <Bullet
              icon={ThumbsUp}
              title="Approvals without accounts"
              text="Clients review and approve in the browser, no sign-up, no app install, no friction."
            />
            <Bullet
              icon={UploadCloud}
              title="Uploads both ways"
              text="Need raw footage or brand assets from the client? They can upload straight into the project through the same link."
            />
          </div>
        </div>
      </section>

      {/* ── MOBILE ───────────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-4 sm:px-6 py-16 grid gap-10 lg:grid-cols-2 lg:items-center">
        <div className="space-y-8">
          <SectionHeading
            eyebrow="Made for phones"
            title="Your clients live on their phones. So does FrameComment."
            sub="Most feedback happens on the move, between shoots, in a taxi, on set. Every review link opens beautifully in any mobile browser: no app to install, no account to create."
          />
          <div className="space-y-5">
            <Bullet
              icon={Smartphone}
              title="Review anywhere"
              text="Clients open the link on their phone, scrub the timeline, and drop comments on the exact moment, with their thumb."
            />
            <Bullet
              icon={Mic}
              title="Talk instead of type"
              text="On the phone it's easier to say it: voice notes record straight from the phone's microphone, pinned to the frame."
            />
            <Bullet
              icon={ThumbsUp}
              title="Approve on the go"
              text="One tap to approve a cut. Your editor sees it instantly, no waiting for the client to get back to a desk."
            />
            <Bullet
              icon={Zap}
              title="The whole app, pocket-sized"
              text="Not just review pages, the entire workspace is built responsive: manage projects, check notifications and share work from your phone."
            />
          </div>
        </div>
        <div className="fc-reveal" aria-hidden="true"><PhoneMock /></div>
      </section>

      {/* ── SECURITY ─────────────────────────────────────────────── */}
      <section id="security" className="scroll-mt-24 mx-auto max-w-6xl px-4 sm:px-6 py-16">
        <SectionHeading
          eyebrow="Security"
          title="Guardrails everywhere it matters."
          sub="Boring, deliberate protections, because your unreleased work is the whole business."
        />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              icon: ShieldCheck,
              title: 'Company isolation',
              text: 'Each company’s data is isolated at the database level with PostgreSQL row-level security, not just application filters.',
            },
            {
              icon: KeyRound,
              title: 'Passkeys & roles',
              text: 'Passkey sign-in, granular team roles from Owner to Editor, and per-share permissions for the outside world.',
            },
            {
              icon: Trash2,
              title: 'Deletion safety windows',
              text: '30-day Trash, cool-down timers on destructive actions, and a cancellable 30-day countdown before a company can be erased.',
            },
            {
              icon: Users,
              title: 'Watermarked previews',
              text: 'Optional preview watermarks keep works-in-progress traceable while clients review.',
            },
          ].map((s) => (
            <Glass key={s.title} className="fc-reveal p-5">
              <s.icon className="w-5 h-5 text-primary" />
              <h3 className="mt-3 text-sm font-semibold text-white">{s.title}</h3>
              <p className="mt-2 text-sm text-white/55 leading-relaxed">{s.text}</p>
            </Glass>
          ))}
        </div>
      </section>

      {/* ── PRICING ──────────────────────────────────────────────── */}
      <section id="pricing" className="scroll-mt-24 mx-auto max-w-6xl px-4 sm:px-6 py-16">
        <SectionHeading
          eyebrow="Pricing"
          title="Simple, honest, pay-as-you-grow."
          sub="No tiers to decode, no features held hostage. Every company gets the full product."
        />
        <div className="mt-10 grid gap-5 lg:grid-cols-2 max-w-4xl">
          <Glass className="fc-reveal p-6">
            <p className="text-sm font-semibold text-white/60">Free</p>
            <p className="mt-2 text-4xl font-bold text-white">
              $0
              <span className="text-base font-normal text-white/55"> / month</span>
            </p>
            <p className="mt-2 text-sm text-white/55">
              Everything included. No credit card required.
            </p>
            <ul className="mt-5 space-y-2.5 text-sm text-white/70">
              {[
                '1 team member',
                '10 GB hosted storage',
                'Unlimited projects & client shares',
                'Every feature, nothing locked',
              ].map((f) => (
                <li key={f} className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-300 mt-0.5 shrink-0" />
                  {f}
                </li>
              ))}
            </ul>
          </Glass>

          <Glass className="fc-reveal p-6 ring-primary/40 bg-primary/[0.06]">
            <p className="text-sm font-semibold text-primary">As you grow</p>
            <p className="mt-2 text-4xl font-bold text-white">
              $25
              <span className="text-base font-normal text-white/55">
                {' '}/ extra member / month
              </span>
            </p>
            <p className="mt-2 text-sm text-white/55">
              Plus $0.10 per GB / month, only on storage we host for you.
            </p>
            <ul className="mt-5 space-y-2.5 text-sm text-white/70">
              {[
                'Your own NAS / R2 / S3 storage: no per-GB fee, ever',
                'Prorated monthly billing in USD, pay only for what you used',
                'No contracts, cancel anytime',
                'Same product as Free, it just scales with you',
              ].map((f) => (
                <li key={f} className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                  {f}
                </li>
              ))}
            </ul>
          </Glass>
        </div>
      </section>

      {/* ── FINAL CTA ────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="fc-aurora absolute bottom-0 left-1/2 -translate-x-1/2 h-[26rem] w-[40rem] rounded-full bg-primary/15 blur-3xl" />
        </div>
        <div className="relative mx-auto max-w-6xl px-4 sm:px-6 py-24 text-center">
          <h2 className="fc-reveal text-3xl sm:text-5xl font-bold text-white leading-tight">
            Ready to stop chasing feedback?
          </h2>
          <p className="fc-reveal mt-4 text-lg text-white/60 max-w-xl mx-auto">
            Start free with your team and your first 10 GB. Bring a client,
            send one link, you&apos;ll feel the difference on the first
            review round.
          </p>
          <div className="fc-reveal mt-8 mx-auto w-full max-w-md sm:max-w-none flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-3">
            <Link
              href="/request-access"
              className="inline-flex h-12 w-full sm:w-auto items-center justify-center gap-2 rounded-xl bg-primary px-6 text-base font-semibold text-primary-foreground hover:brightness-110 transition-[filter]"
            >
              Request early access
              <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="/login"
              className="inline-flex h-12 w-full sm:w-auto items-center justify-center rounded-xl px-6 text-base text-white/80 hover:text-white bg-white/[0.06] hover:bg-white/[0.1] ring-1 ring-white/15 transition-colors"
            >
              Sign in
            </Link>
          </div>
        </div>
      </section>

      </main>

      <MarketingFooter onLanding />
    </div>
  )
}
