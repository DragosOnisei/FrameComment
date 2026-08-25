'use client'

import Image from 'next/image'
import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Film, Layers } from 'lucide-react'
import { cn } from '@/lib/utils'
import { storyboardCellStyle, storyboardGridOf } from '@/lib/storyboard-grid'

interface ThumbnailGridProps {
  videosByName: Record<string, any[]>
  thumbnailsByName: Map<string, string>
  /**
   * 7.1.3: sprite sheet per name, so a tile scrubs under the cursor the way
   * every other thumbnail in the product does. Optional — a tile without one
   * simply shows its still.
   */
  storyboardsByName?: Map<string, string>
  thumbnailsLoading: boolean
  onVideoSelect: (videoName: string) => void
  /**
   * 7.1.3: the client name, the project title and "select a video to begin"
   * used to head this grid. They are gone at Dragos's request, and the reason
   * is worth recording: they were the visual signature of the share page this
   * product started with, and seeing them told him he had been sent back to the
   * old platform. The folder share — the newer surface, and the one he wants
   * this to resemble — introduces itself with a breadcrumb and gets on with
   * showing the work.
   *
   * `projectDescription` stays because it is not chrome: it is a sentence the
   * studio wrote FOR this client.
   */
  projectDescription?: string
}

export default function ThumbnailGrid({
  videosByName,
  thumbnailsByName,
  storyboardsByName,
  thumbnailsLoading,
  onVideoSelect,
  projectDescription,
}: ThumbnailGridProps) {
  const tv = useTranslations('videos')
  // Which tile is being scrubbed, and how far across it the pointer sits.
  // Keyed by name so moving quickly across several tiles cannot leave an old
  // one frozen mid-sprite.
  const [scrub, setScrub] = useState<{ name: string; f: number } | null>(null)

  // 6.11.0: plain alphabetical. The list used to put "for review" before
  // "approved", which meant approving a clip moved it — the order shifted
  // under you as a side effect of an unrelated action.
  const videoNames = useMemo(
    () => Object.keys(videosByName).sort((a, b) => a.localeCompare(b)),
    [videosByName],
  )

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* 7.1.3: no client name, no project title, no "select a video to
          begin" — see the props above. What the studio actually wrote for this
          client still shows. */}
      {projectDescription && (
        <p className="text-sm sm:text-base text-muted-foreground max-w-xl mx-auto mb-6 text-center pt-2">
          {projectDescription}
        </p>
      )}

      {/* 6.2.1: honest empty state. Previously zero tiles meant zero feedback:
          the visitor saw a title and nothing else, with no way to tell whether
          the link was wrong, the upload was still processing, or the studio had
          removed the material. */}
      {videoNames.length === 0 && (
        <div className="mx-auto max-w-md rounded-xl bg-white/[0.03] ring-1 ring-white/10 px-6 py-8 text-center">
          <p className="text-sm font-medium text-foreground/85">
            Nothing to review here yet
          </p>
          <p className="mt-1.5 text-sm text-muted-foreground">
            The videos may still be processing, or this link points somewhere
            that has been moved. Ask the studio to resend it.
          </p>
        </div>
      )}

      {/* Grid */}
      <div className="grid grid-cols-2 gap-3 sm:gap-5 md:grid-cols-3 lg:gap-6 xl:grid-cols-4 2xl:grid-cols-5">
        {videoNames.map((name) => {
          const videos = videosByName[name]
          const versionCount = videos.length
          const thumbnailUrl = thumbnailsByName.get(name)
          // 7.1.3: hover-scrub, the same gesture the version reel and the video
          // cards inside the app use. The sprite geometry travels on the row
          // (6.9.3 made the grid scale with duration), so it is read from the
          // video rather than assumed to be 10x10.
          const storyboardUrl = storyboardsByName?.get(name)
          const isScrubbing = scrub?.name === name && !!storyboardUrl
          // The geometry must come from the SAME row the sprite was minted for
          // — the caller picks it by `thumbnailPath`, which is not always the
          // newest version. Reading cols/rows off `videos[0]` instead would use
          // one version's grid against another version's sheet, and since 6.9.3
          // sized the grid by duration, two cuts of different lengths would then
          // scrub to the wrong frames.
          const spriteRow = videos.find((v: any) => v.thumbnailPath) ?? videos[0]
          const scrubStyle = isScrubbing
            ? storyboardCellStyle(storyboardUrl, scrub.f, storyboardGridOf(spriteRow))
            : undefined

          return (
            <button
              key={name}
              onClick={() => onVideoSelect(name)}
              onMouseMove={(e) => {
                if (!storyboardUrl) return
                const r = e.currentTarget.getBoundingClientRect()
                const f = Math.min(0.999, Math.max(0, (e.clientX - r.left) / r.width))
                setScrub({ name, f })
              }}
              onMouseLeave={() => setScrub((cur) => (cur?.name === name ? null : cur))}
              className={cn(
                'group relative rounded-lg overflow-hidden',
                'bg-card border border-border',
                'hover:border-primary/50 hover:shadow-elevation-lg',
                'transition-all duration-200',
                'focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background'
              )}
            >
              {/* Thumbnail */}
              <div className="aspect-video relative bg-black">
                {thumbnailsLoading ? (
                  // Loading skeleton
                  <div className="absolute inset-0 animate-pulse bg-muted" />
                ) : thumbnailUrl ? (
                  // Thumbnail image - object-contain preserves aspect ratio
                  // unoptimized: in S3 mode /api/content/{token} returns a 302 redirect to a
                  // presigned URL — the Next.js image optimizer cannot follow cross-origin
                  // redirects, so we bypass it and let the browser handle the redirect natively.
                  <Image
                    src={thumbnailUrl}
                    alt={name}
                    fill
                    sizes="(min-width: 1536px) 20vw, (min-width: 1280px) 25vw, (min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                    className="object-contain"
                    draggable={false}
                    unoptimized
                  />
                ) : (
                  // Placeholder
                  <div className="absolute inset-0 flex items-center justify-center bg-muted">
                    <Film className="w-8 h-8 sm:w-12 sm:h-12 text-muted-foreground/50" />
                  </div>
                )}

                {/* Sprite layer — only painted while the pointer is over this
                    tile. A CSS background-position swap, so there is no image
                    load and no seek per frame. */}
                {storyboardUrl && (
                  <div
                    className={cn(
                      'absolute inset-0 transition-opacity duration-75',
                      isScrubbing ? 'opacity-100' : 'opacity-0',
                    )}
                    style={scrubStyle}
                    aria-hidden
                  />
                )}

                {/* Hover overlay. Suppressed while scrubbing — darkening the
                    frame the user is trying to read defeats the point. */}
                <div
                  className={cn(
                    'absolute inset-0 transition-colors duration-200',
                    isScrubbing ? 'bg-black/0' : 'bg-black/0 group-hover:bg-black/20',
                  )}
                />

                {/* Version count badge */}
                {versionCount > 1 && (
                  <div className="absolute bottom-2 right-2 bg-black/70 text-white text-xs px-1.5 py-0.5 rounded flex items-center gap-1">
                    <Layers className="w-3 h-3" />
                    <span>{versionCount}</span>
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="p-3 sm:p-4">
                <p className="text-sm font-medium text-foreground truncate text-left">
                  {name}
                </p>
                <p className="text-xs text-muted-foreground mt-1 text-left">
                  {versionCount} {versionCount === 1 ? tv('versions').slice(0, -1) : tv('versions')}
                </p>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
