'use client'

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ImgHTMLAttributes,
  type SyntheticEvent,
} from 'react'

/**
 * 7.18.11: a video thumbnail that says it is loading.
 *
 * A thumbnail is a token-minted `/api/content/…` request, and on the
 * FrameComment Server bucket it is a redirect to a presigned URL — a cold one
 * takes a moment, and until it arrives the card, the folder mosaic and Quick
 * Look's tiles were plain black boxes (Dragos's screenshot of "DAV Patriot
 * Boot Camp"): no way to tell "loading" from "this video has no picture".
 * This draws the app's spinner — the same ring the "Generating thumbnail…"
 * state uses — over the slot until the image has decoded, then fades the
 * picture in.
 *
 * Two details that matter:
 *   - A CACHED image can finish before React attaches `onLoad`, so the
 *     element's own `complete` flag is checked right after mount; otherwise a
 *     cached thumbnail would spin forever.
 *   - The spinner shows only until the FIRST load. Folder pages poll while
 *     anything is processing and every poll mints fresh tokens, so `src`
 *     changes under a picture that is already on screen; the browser keeps
 *     painting the old bitmap until the new one is ready. Resetting on every
 *     `src` would flash a spinner over a visible thumbnail every few seconds.
 *
 * An error settles the spinner too: callers that swap to a glyph on error
 * keep doing so through `onError`; the rest show the slot's own background.
 *
 * The parent must be positioned (`relative`/`absolute`): the spinner is an
 * absolute layer over it. Every current caller already is.
 */

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

export type ThumbnailSpinnerSize = 'sm' | 'md'

const SPINNER_CLASS: Record<ThumbnailSpinnerSize, string> = {
  sm: 'w-4 h-4 border-[1.5px]',
  md: 'w-6 h-6 border-2',
}

export interface ThumbnailImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  src: string
  /** Ring size: `sm` for mosaic tiles and list rows, `md` for cards. */
  spinnerSize?: ThumbnailSpinnerSize
}

export default function ThumbnailImage({
  src,
  className,
  spinnerSize = 'md',
  onLoad,
  onError,
  alt = '',
  ...rest
}: ThumbnailImageProps) {
  const imgRef = useRef<HTMLImageElement>(null)
  const [settled, setSettled] = useState(false)

  // Cached images can be complete before the load listener exists.
  useIsoLayoutEffect(() => {
    const img = imgRef.current
    if (img && img.complete && img.naturalWidth > 0) setSettled(true)
  }, [])

  const handleLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    setSettled(true)
    onLoad?.(e)
  }
  const handleError = (e: SyntheticEvent<HTMLImageElement>) => {
    setSettled(true)
    onError?.(e)
  }

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        onLoad={handleLoad}
        onError={handleError}
        className={`${className ?? ''} transition-opacity duration-200 ${settled ? 'opacity-100' : 'opacity-0'}`}
        {...rest}
      />
      {!settled && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <span
            className={`inline-block rounded-full border-muted-foreground/30 border-t-primary animate-spin ${SPINNER_CLASS[spinnerSize]}`}
          />
        </span>
      )}
    </>
  )
}
