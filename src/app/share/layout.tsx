import { DownloadManagerProvider } from '@/contexts/DownloadManager'
import { DownloadBanners } from '@/components/DownloadBanners'

/**
 * 3.2.6+: shared layout for the whole public share area
 * (`/share/folder/[slug]` AND `/share/[token]`).
 *
 * The DownloadManagerProvider + bottom-right <DownloadBanners /> live
 * here, ABOVE both the folder grid and the video player, so a download
 * started on the folder share page survives client-side navigation
 * into a video and back. Previously the provider was mounted INSIDE the
 * folder page component, so opening a video (which routes to
 * `/share/[token]?video=…`) unmounted the provider — the in-flight
 * folder ZIP kept downloading in the background, but its progress
 * banner vanished and never came back, so the client had no idea
 * whether the download was still running or how long was left.
 *
 * Because `/share/layout.tsx` is a common ancestor of both routes,
 * Next.js App Router preserves it across navigation between them, so
 * the job state (and its banner) persist seamlessly.
 *
 * The folder page no longer wraps itself in its own provider — it now
 * consumes this one via context.
 */
export default function ShareDownloadLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <DownloadManagerProvider>
      {children}
      <DownloadBanners />
    </DownloadManagerProvider>
  )
}
