/**
 * 7.6.2: where HLS should play NATIVELY instead of through hls.js.
 *
 * Reported 2026-09-09: casting a video from the phone to a TV played only
 * the audio. That is the signature of AirPlay meeting Media Source
 * Extensions: an MSE stream is a blob assembled inside the browser, there is
 * no URL a television can fetch, so Safari hands the TV nothing but the
 * decoded sound. The player believed iPhones had no MSE and would fall back
 * to native `<video src=master.m3u8>` — true until iOS 17.1 (October 2023),
 * when Safari shipped ManagedMediaSource and hls.js 1.5+ started using it, so
 * `Hls.isSupported()` became true on the phone and hls.js quietly took over
 * the very element whose native `src` was already set.
 *
 * hls.js's own README now recommends the opposite for exactly this platform:
 * "Only use native HLS in browsers with ManagedMediaSource (e.g. modern
 * Safari) where native playback is well-supported." Native playback is what
 * AirPlay can hand to a TV — the TV fetches the tokenized master playlist
 * itself, and the HLS route already accepts that (admin tokens skip the
 * session check; share tokens carry their own session in the token).
 *
 * The decision is deliberately narrow: iPhone and iPad Safari only. macOS
 * Safari keeps hls.js — that is where the pinned-quality menu the studio
 * relies on lives — and Chrome/Android never have ManagedMediaSource, so
 * they are untouched. The fingerprint is UA-free: iOS exposes ONLY
 * ManagedMediaSource (no `MediaSource` global); iPadOS exposes both but
 * reports touch points; the Mac exposes both and reports none.
 */
export interface NativeHlsEnvironment {
  canPlayNativeHls: boolean
  hasManagedMediaSource: boolean
  hasMediaSource: boolean
  maxTouchPoints: number
}

export function decidePrefersNativeHls(env: NativeHlsEnvironment): boolean {
  if (!env.canPlayNativeHls) return false
  if (!env.hasManagedMediaSource) return false
  // iPhone: MMS without MSE. iPad: both, but a touch device.
  return !env.hasMediaSource || env.maxTouchPoints > 1
}

export function prefersNativeHls(video?: HTMLVideoElement | null): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  const probe = video ?? document.createElement('video')
  return decidePrefersNativeHls({
    canPlayNativeHls: !!probe.canPlayType?.('application/vnd.apple.mpegurl'),
    hasManagedMediaSource: 'ManagedMediaSource' in window,
    hasMediaSource: 'MediaSource' in window,
    maxTouchPoints: typeof navigator !== 'undefined' ? navigator.maxTouchPoints || 0 : 0,
  })
}
