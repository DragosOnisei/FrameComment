'use client'

import { useEffect, useRef, type RefObject } from 'react'

/**
 * 7.18.0: the ring of light around the audio player's artwork that moves
 * with the music.
 *
 * An audio file has no picture, so the stage shows a note in a circle and
 * the name. Dragos asked for "something that reacts to the music while it
 * plays — not much, a circle around the icon that follows the beat". This
 * is that: a ring of thin bars radiating from the icon's circle, each bar
 * the height of one frequency band, mirrored left/right like a classic
 * circular spectrum, plus a soft halo that breathes with the bass.
 *
 * The sound is read with Web Audio: ONE `MediaElementAudioSourceNode` per
 * media element, kept in a module-level WeakMap, because an element can be
 * captured once in its life and never released — a second
 * `createMediaElementSource` on the same element throws, and the version
 * reel swaps `src` on the same <video>. The source is wired
 * analyser → destination at once, so the sound still reaches the speaker.
 *
 * Two things can silence the player if done wrong, and both are guarded:
 *   - A media element whose bytes come from ANOTHER ORIGIN without CORS
 *     yields silence through Web Audio (the element's output is routed
 *     through the graph, so the speaker goes silent too). Before capturing,
 *     `probeSameOrigin` fetches one byte of the stream with
 *     `redirect: 'manual'`: a redirect (a presigned bucket URL, a CDN)
 *     answers as `opaqueredirect`, and then the ring only breathes on a
 *     timer and never touches the element. The content route proxies
 *     AUDIO for exactly this reason (see s3GetObjectRange), so on the app's
 *     own storage the probe passes.
 *   - An AudioContext starts suspended under autoplay policy and a
 *     suspended context mutes a captured element. `resume()` is called on
 *     every `play` event — the click that started playback is the user
 *     activation the browser wants.
 *
 * Drawing is a canvas under the icon, rAF only while playing; when the
 * music stops the bars decay to rest and the loop ends. Pointer events pass
 * through: the stage's click still toggles play.
 */

interface Captured {
  ctx: AudioContext
  analyser: AnalyserNode
}

const captured = new WeakMap<HTMLMediaElement, Captured>()
const probed = new WeakMap<HTMLMediaElement, Promise<boolean>>()

/** Bars around the ring (both halves together). Even, so the mirror is exact. */
const BAR_COUNT = 72
/** Which part of the spectrum the ring shows — above ~1/2 is mostly hiss. */
const SPECTRUM_FRACTION = 0.55
/** Speeds of the per-bar follower: quick up, slower down, like a VU meter. */
const ATTACK = 0.45
const DECAY = 0.12
/**
 * A mastered track keeps every band near the top of the byte scale, so a
 * linear mapping pinned all the bars at full length for the whole song (the
 * test tone, with one quiet band, had hidden that). Only the part above
 * `LEVEL_FLOOR` counts, and it is squared: loud stays loud, average sits
 * around a third, and the ring moves with the beat instead of standing.
 */
const LEVEL_FLOOR = 0.42
function shape(v: number): number {
  const above = Math.max(0, (v - LEVEL_FLOOR) / (1 - LEVEL_FLOOR))
  return above * above
}

async function probeSameOrigin(src: string): Promise<boolean> {
  try {
    const url = new URL(src, window.location.href)
    if (url.origin !== window.location.origin) return false
    const res = await fetch(url.href, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      redirect: 'manual',
      cache: 'no-store',
    })
    if (res.type === 'opaqueredirect') return false
    // Drain the single byte so the connection is released.
    await res.arrayBuffer().catch(() => undefined)
    return res.status === 206 || res.status === 200
  } catch {
    return false
  }
}

function capture(el: HTMLMediaElement): Captured | null {
  const existing = captured.get(el)
  if (existing) return existing
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  let ctx: AudioContext | null = null
  try {
    ctx = new Ctor()
    const source = ctx.createMediaElementSource(el)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.72
    source.connect(analyser)
    analyser.connect(ctx.destination)
    const entry = { ctx, analyser }
    captured.set(el, entry)
    return entry
  } catch {
    // createMediaElementSource threw (already captured by something else,
    // or the browser refused) — nothing was connected, the element is
    // untouched. Close the context so it is not leaked.
    ctx?.close().catch(() => undefined)
    return null
  }
}

export interface AudioReactiveRingProps {
  mediaRef: RefObject<HTMLMediaElement | null>
  /** The player's playing state; the loop runs only while true. */
  playing: boolean
  /** Diameter of the icon circle the ring hugs, in CSS px. */
  innerDiameter: number
  /** Longest bar, in CSS px. */
  reach?: number
  className?: string
}

export default function AudioReactiveRing({
  mediaRef,
  playing,
  innerDiameter,
  reach = 44,
  className,
}: AudioReactiveRingProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const levelsRef = useRef<Float32Array>(new Float32Array(BAR_COUNT / 2))
  const analyserRef = useRef<AnalyserNode | null>(null)
  const haloRef = useRef(0)
  // The halo fades out well past the longest bar; the canvas must hold ALL
  // of it, or the gradient is cut into a square — the first version sized
  // the canvas to the bars alone and the glow ended in four straight edges.
  const haloReach = reach + 56
  const size = Math.ceil(innerDiameter / 2 + 10 + haloReach + 4) * 2

  // Capture the element once we know its bytes are ours; resume the
  // context on every play (autoplay policy).
  useEffect(() => {
    const el = mediaRef.current
    if (!el) return
    let cancelled = false
    const onPlay = () => {
      const entry = captured.get(el)
      if (entry && entry.ctx.state === 'suspended') entry.ctx.resume().catch(() => undefined)
    }
    el.addEventListener('play', onPlay)

    const src = el.currentSrc || el.src
    if (src) {
      let p = probed.get(el)
      if (!p) {
        p = probeSameOrigin(src)
        probed.set(el, p)
      }
      p.then((ok) => {
        if (cancelled || !ok) return
        const entry = capture(el)
        if (!entry) return
        analyserRef.current = entry.analyser
        if (!el.paused && entry.ctx.state === 'suspended') entry.ctx.resume().catch(() => undefined)
      })
    }
    return () => {
      cancelled = true
      el.removeEventListener('play', onPlay)
    }
    // `playing` is in the deps so a src that was empty on mount (the reel
    // sets it a tick later) is probed on the first play.
  }, [mediaRef, playing])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    const g = canvas.getContext('2d')
    if (!g) return

    const tint = getComputedStyle(canvas).getPropertyValue('--spotlight-tint').trim() || '211 100% 50%'
    const half = BAR_COUNT / 2
    const levels = levelsRef.current
    const bins = new Uint8Array(128)
    let raf = 0
    let last = performance.now()
    let idlePhase = 0

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const analyser = analyserRef.current
      let target: (i: number) => number
      let bass = 0
      if (analyser && playing) {
        analyser.getByteFrequencyData(bins)
        const usable = Math.floor(bins.length * SPECTRUM_FRACTION)
        target = (i) => {
          // Spread the bars over the usable spectrum, low notes at the
          // top of the ring, highs toward the bottom.
          const from = Math.floor((i / half) * usable)
          const to = Math.max(from + 1, Math.floor(((i + 1) / half) * usable))
          let sum = 0
          for (let b = from; b < to; b++) sum += bins[b]
          const v = sum / (to - from) / 255
          // Highs are naturally quieter; lift them a little so the ring
          // is alive all the way round.
          return shape(Math.min(1, v * (1 + (i / half) * 0.5)))
        }
        bass = shape((bins[1] + bins[2] + bins[3]) / (3 * 255))
      } else if (playing) {
        // No analyser (bytes from another origin): breathe on a timer.
        idlePhase += dt * 1.6
        target = (i) => 0.18 + 0.1 * Math.sin(idlePhase + i * 0.35)
        bass = 0.25 + 0.15 * Math.sin(idlePhase)
      } else {
        target = () => 0
      }

      let energy = 0
      for (let i = 0; i < half; i++) {
        const t = target(i)
        const k = t > levels[i] ? ATTACK : DECAY
        levels[i] += (t - levels[i]) * k
        energy += levels[i]
      }
      haloRef.current += (bass - haloRef.current) * (bass > haloRef.current ? 0.35 : 0.08)

      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, size, size)
      const cx = size / 2
      const cy = size / 2
      const r0 = innerDiameter / 2 + 10

      // Halo: breathes with the bass.
      const halo = haloRef.current
      if (halo > 0.01) {
        const grad = g.createRadialGradient(cx, cy, r0 - 6, cx, cy, r0 + haloReach)
        // Eased stops: most of the light near the ring, a long soft tail
        // that reaches zero before the canvas edge.
        grad.addColorStop(0, `hsl(${tint} / ${0.3 * halo})`)
        grad.addColorStop(0.35, `hsl(${tint} / ${0.14 * halo})`)
        grad.addColorStop(0.7, `hsl(${tint} / ${0.04 * halo})`)
        grad.addColorStop(1, `hsl(${tint} / 0)`)
        g.fillStyle = grad
        g.beginPath()
        g.arc(cx, cy, r0 + haloReach, 0, Math.PI * 2)
        g.fill()
      }

      // Bars, mirrored: bar i on the right at angle θ, its twin on the left.
      g.lineCap = 'round'
      g.lineWidth = 3
      for (let i = 0; i < half; i++) {
        const len = 4 + levels[i] * reach
        const theta = -Math.PI / 2 + ((i + 0.5) / half) * Math.PI
        const alpha = 0.35 + levels[i] * 0.6
        g.strokeStyle = `hsl(${tint} / ${alpha})`
        for (const sign of [1, -1] as const) {
          const dx = Math.cos(theta) * sign
          const dy = Math.sin(theta)
          g.beginPath()
          g.moveTo(cx + dx * r0, cy + dy * r0)
          g.lineTo(cx + dx * (r0 + len), cy + dy * (r0 + len))
          g.stroke()
        }
      }

      // Keep going while there is music, or until the bars have settled.
      if (playing || energy > 0.02 || halo > 0.01) {
        raf = requestAnimationFrame(draw)
      } else {
        raf = 0
      }
    }
    raf = requestAnimationFrame(draw)
    return () => {
      if (raf) cancelAnimationFrame(raf)
    }
  }, [playing, size, innerDiameter, reach, haloReach])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: size, height: size }}
      aria-hidden
    />
  )
}
