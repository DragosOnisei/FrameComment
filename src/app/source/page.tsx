import type { Metadata } from 'next'
import { MarketingNav } from '@/components/marketing/MarketingNav'
import { MarketingFooter } from '@/components/marketing/MarketingFooter'
import { LICENSE_LINKS } from '@/components/LicenseNotice'
import pkg from '../../../package.json'

/**
 * 6.7.1 — /source: the AGPL §13 written offer, in full.
 *
 * Section 13 requires that people who use this software over a network be
 * prominently offered the Corresponding Source. The footer line carries the
 * offer on every page; this page is where it is actually honoured — what the
 * software is, who wrote what, where the exact source for the running version
 * lives, and what the licence lets anyone do with it.
 *
 * Written plainly and without hedging. An offer that is technically present
 * but reads like it hopes nobody follows it is not an offer.
 */

export const metadata: Metadata = {
  title: 'Source code & licence — FrameComment',
  description:
    'FrameComment is free software licensed under the AGPL-3.0. Here is the source code for the version running this site, its licence, and its upstream origin.',
  alternates: { canonical: '/source' },
  robots: { index: true, follow: true },
  openGraph: {
    type: 'website',
    url: '/source',
    siteName: 'FrameComment',
    title: 'Source code & licence — FrameComment',
    description: 'FrameComment is free software licensed under the AGPL-3.0.',
  },
}

// Read at build time from package.json, not from an env var: `npm_package_*`
// is only set when the process was started by npm, and the container starts
// the server directly. The §13 offer promises the source for the version that
// is actually running, so the number has to be right.
const APP_VERSION: string | null = pkg.version ?? null
const DOCKER_IMAGE = 'dragosonisei/framecomment'

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-white underline underline-offset-2 hover:text-white/80 transition-colors"
    >
      {children}
    </a>
  )
}

export default function SourcePage() {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <MarketingNav />

      <main className="flex-1">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 py-16 sm:py-20">
          <h1 className="text-3xl sm:text-4xl font-semibold text-white">
            Source code &amp; licence
          </h1>
          <p className="mt-4 text-white/70">
            FrameComment is free software. The application serving this website — every page
            you can reach here, and the app behind the login — is licensed under the{' '}
            <ExternalLink href={LICENSE_LINKS.AGPL_URL}>
              GNU Affero General Public License, version 3
            </ExternalLink>
            . You are entitled to the complete source code for it, and you are free to run,
            study, change and redistribute it under the same licence.
          </p>

          <section className="mt-10">
            <h2 className="text-lg font-semibold text-white">Getting the source</h2>
            <p className="mt-3 text-white/70">
              The complete Corresponding Source for the version running here is published at{' '}
              <ExternalLink href={LICENSE_LINKS.SOURCE_URL}>
                github.com/DragosOnisei/FrameComment
              </ExternalLink>
              . Each release is tagged, so the exact source for a given deployment can be
              checked out by its version tag.
            </p>
            <p className="mt-3 text-white/70">
              The published container image is{' '}
              <code className="rounded bg-white/[0.06] px-1.5 py-0.5 text-white/90">
                {DOCKER_IMAGE}
              </code>
              , built by CI from that repository.
              {APP_VERSION ? (
                <>
                  {' '}
                  This site is currently running version{' '}
                  <code className="rounded bg-white/[0.06] px-1.5 py-0.5 text-white/90">
                    {APP_VERSION}
                  </code>
                  .
                </>
              ) : null}
            </p>
            <p className="mt-3 text-white/70">
              If you cannot use GitHub, or the repository is ever unreachable, write to{' '}
              <a
                href="mailto:dragos.onisei@mindqub.eu"
                className="text-white underline underline-offset-2 hover:text-white/80 transition-colors"
              >
                dragos.onisei@mindqub.eu
              </a>{' '}
              and we will send you the Corresponding Source for the running version by another
              means.
            </p>
          </section>

          <section className="mt-10">
            <h2 className="text-lg font-semibold text-white">Where it came from</h2>
            <p className="mt-3 text-white/70">
              FrameComment is a derivative work of{' '}
              <ExternalLink href={LICENSE_LINKS.UPSTREAM_URL}>ViTransfer</ExternalLink> by
              Mansi Visuals, forked from ViTransfer 1.0.2 on 2 May 2026 and re-versioned from
              1.0.0. The copyright in the inherited code belongs to its original author, who
              licensed it under the AGPL-3.0. Everything added since is copyright MINDQUB
              S.R.L. and is licensed under the same terms, because the licence requires the
              work to be released as a whole under the AGPL.
            </p>
            <p className="mt-3 text-white/70">
              The FrameComment name, logo and visual identity are MINDQUB&apos;s trademarks
              and are not covered by the software licence. You may run and modify the code;
              you may not present your version as FrameComment.
            </p>
          </section>

          <section className="mt-10">
            <h2 className="text-lg font-semibold text-white">What you may do with it</h2>
            <ul className="mt-3 space-y-2 text-white/70">
              <li>• Run it, for any purpose, including commercially.</li>
              <li>• Read it, change it, and self-host your own instance.</li>
              <li>
                • Redistribute it, modified or not, under the AGPL-3.0 — and if you run a
                modified version as a network service, offer your users its source in turn.
                That last part is the clause that brought you to this page.
              </li>
            </ul>
            <p className="mt-3 text-white/70">
              The licence text ships with the source, in{' '}
              <ExternalLink href={`${LICENSE_LINKS.SOURCE_URL}/blob/main/LICENSE`}>
                LICENSE
              </ExternalLink>
              , alongside{' '}
              <ExternalLink href={`${LICENSE_LINKS.SOURCE_URL}/blob/main/NOTICE`}>
                NOTICE
              </ExternalLink>{' '}
              and{' '}
              <ExternalLink href={`${LICENSE_LINKS.SOURCE_URL}/blob/main/LICENSING-NOTES.md`}>
                LICENSING-NOTES.md
              </ExternalLink>
              , which record the attribution in detail.
            </p>
          </section>

          <section className="mt-10">
            <h2 className="text-lg font-semibold text-white">Your data is not the software</h2>
            <p className="mt-3 text-white/70">
              The licence covers the code, not the content. Your projects, videos, comments
              and files remain yours; how they are handled is described in the{' '}
              <a
                href="/privacy"
                className="text-white underline underline-offset-2 hover:text-white/80 transition-colors"
              >
                Privacy Policy
              </a>
              .
            </p>
          </section>
        </div>
      </main>

      <MarketingFooter />
    </div>
  )
}
