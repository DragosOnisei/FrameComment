import type { Metadata } from 'next'
import { MarketingNav } from '@/components/marketing/MarketingNav'
import { MarketingFooter } from '@/components/marketing/MarketingFooter'

/**
 * 5.14.0, Terms of Use for the FrameComment service.
 *
 * Original text written for this product (structured in the spirit of
 * standard SaaS terms; not copied from any other company's terms).
 * Operator details supplied by the owner: MINDQUB S.R.L., Romania.
 */

export const metadata: Metadata = {
  title: 'Terms of Use — FrameComment',
  description:
    'The terms that govern your use of FrameComment, the video review and collaboration platform operated by MINDQUB S.R.L.',
  alternates: { canonical: '/terms' },
  robots: { index: true, follow: true },
  openGraph: {
    type: 'website',
    url: '/terms',
    siteName: 'FrameComment',
    title: 'Terms of Use — FrameComment',
    description: 'The terms that govern your use of FrameComment.',
  },
}

const EFFECTIVE_DATE = 'August 4, 2026'
const CONTACT_EMAIL = 'dragos.onisei@mindqub.eu'

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="text-xl font-semibold text-white mt-10 mb-3">{children}</h2>
}

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <MarketingNav />
      <main className="mx-auto max-w-3xl px-4 sm:px-6 py-14">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary mb-3">
          Legal
        </p>
        <h1 className="text-3xl sm:text-4xl font-bold text-white">Terms of Use</h1>
        <p className="mt-3 text-sm text-white/45">Effective date: {EFFECTIVE_DATE}</p>

        <div className="mt-8 space-y-4 text-[15px] leading-relaxed text-white/70">
          <p>
            These Terms of Use (the &ldquo;Terms&rdquo;) govern your access to and use of the
            FrameComment website and service (the &ldquo;Service&rdquo;), available at
            framecomment.com. By creating an account, accepting an invitation, opening a
            share link, or otherwise using the Service, you agree to these Terms. If you
            are using the Service on behalf of a company, you represent that you have the
            authority to bind that company, and &ldquo;you&rdquo; refers to that company.
          </p>

          <H2>1. Who we are</H2>
          <p>
            The Service is operated by <strong className="text-white">MINDQUB S.R.L.</strong>, a
            Romanian limited liability company, with its registered office at Strada
            Vespasian nr. 47, Camera 2, Sector 1, București 011981, Romania. Company
            Registration No.: J2025022239001. VAT / Tax ID: RO51533881. You can reach us
            at <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">{CONTACT_EMAIL}</a>.
          </p>

          <H2>2. The Service, and its private beta status</H2>
          <p>
            FrameComment is a video review and collaboration platform: teams upload video
            and related files, collect time-coded feedback, manage versions, and share
            work with their clients through links. The Service is currently in{' '}
            <strong className="text-white">private beta</strong>: creating a company requires an
            invite, features evolve quickly, and functionality may change, be added, or be
            removed as the product matures. We work hard to keep the Service stable, but
            during the beta we cannot promise uninterrupted availability.
          </p>

          <H2>3. Accounts and security</H2>
          <p>
            You must provide accurate information when creating an account and keep your
            credentials secure. You are responsible for all activity under your account.
            Company Owners and Admins control who joins their company workspace, what
            roles members have, and what is shared externally; the company is responsible
            for the actions of its members and for the access it grants through share
            links. Notify us immediately at the contact address above if you suspect
            unauthorized use of your account.
          </p>

          <H2>4. Your content</H2>
          <p>
            You retain all rights to the videos, images, documents, comments and other
            material you upload (&ldquo;Content&rdquo;). You grant MINDQUB S.R.L. a limited,
            worldwide, non-exclusive license to host, store, transmit, transcode,
            generate previews, thumbnails and transcripts of, and display your Content,
            solely to the extent necessary to operate and provide the Service to you and
            to the people you share it with. This license ends when you delete the
            Content or your company account, subject to the deletion timelines described
            in Section 8. We claim no ownership of your work, and we do not use your
            Content to train AI models.
          </p>
          <p>
            You are responsible for your Content: you must hold the rights needed to
            upload and share it, and it must not violate any law or third-party right.
          </p>

          <H2>5. Acceptable use</H2>
          <p>
            You agree not to misuse the Service. In particular, you will not: upload or
            share unlawful content (including content that infringes copyright or
            contains child sexual abuse material); attempt to access other companies&rsquo;
            data or probe, scan, or test the vulnerability of the Service; interfere with
            its operation, circumvent usage limits or security measures; resell the
            Service without our written agreement; or use it to send spam or distribute
            malware. We may suspend or terminate accounts that violate these rules,
            where practicable with prior notice.
          </p>

          <H2>6. Share links</H2>
          <p>
            The Service lets you create share links that give people outside your company
            access to selected Content, optionally protected by passwords and expiration
            dates, and optionally allowing comments, downloads or uploads.
            Anyone with a valid link (and password, where set) can access what you chose
            to share; you are responsible for deciding what you share, with whom, and
            with what protections.
          </p>

          <H2>7. Fees and billing</H2>
          <p>
            The Service includes a free allowance (currently 1 team member and 10 GB of
            hosted storage per company). Beyond it, usage is billed monthly and prorated:
            a fee per additional member per month, and a fee per GB per month that applies
            only to storage hosted by us, storage you connect yourself (your own server,
            Cloudflare R2, or AWS S3) is never billed per GB. Current prices are shown on
            the pricing section of our website and in your billing settings; prices are in
            USD and exclude any applicable taxes. Payments are processed by Stripe. If a
            charge fails, we will retry and notify you; continued non-payment after a
            grace period may lead to suspension of administrative access until settled. We
            may change prices with at least 30 days&rsquo; prior notice.
          </p>

          <H2>8. Term, termination and deletion</H2>
          <p>
            You can stop using the Service at any time. Company Owners can delete their
            company from the settings: deletion starts a 30-day countdown visible to the
            whole team and cancellable by any Owner, after which the company and its data
            are permanently erased. Deleted projects and files first spend up to 30 days
            in a recoverable Trash before being permanently removed. We may terminate or
            suspend access for material breach of these Terms; where reasonable, we will
            give you notice and an opportunity to export your Content first.
          </p>

          <H2>9. Third-party services</H2>
          <p>
            The Service relies on selected third-party providers, for example Stripe for
            payment processing and an AI provider for optional transcript generation
            (audio is processed only when you request a transcript). If you connect your
            own storage (NAS, Cloudflare R2, AWS S3), the availability and durability of
            that storage is your responsibility and subject to your agreement with those
            providers.
          </p>

          <H2>10. Intellectual property</H2>
          <p>
            The Service itself, its software, design and branding, is owned by MINDQUB
            S.R.L. and protected by law. These Terms do not grant you any right to use
            our branding, and no rights are granted except as expressly set out here.
          </p>

          <H2>11. Disclaimers</H2>
          <p>
            The Service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;,
            without warranties of any kind, express or implied, including fitness for a
            particular purpose and non-infringement, to the maximum extent permitted by
            law. Keep independent copies of irreplaceable source material, no online
            service should ever be your only copy.
          </p>

          <H2>12. Limitation of liability</H2>
          <p>
            To the maximum extent permitted by law, MINDQUB S.R.L. shall not be liable
            for indirect, incidental, special, consequential or punitive damages, or for
            lost profits, revenues, or data, arising from your use of the Service. Our
            total aggregate liability for all claims relating to the Service is limited
            to the amounts you paid us for the Service in the 12 months preceding the
            event giving rise to the claim (or EUR 100 if you have paid nothing). Nothing
            in these Terms limits liability that cannot be limited by law, including
            liability for intent or gross negligence, or your statutory rights as a
            consumer where applicable.
          </p>

          <H2>13. Changes to these Terms</H2>
          <p>
            We may update these Terms as the Service evolves. If a change is material, we
            will notify you (for example by email or an in-app notice) before it takes
            effect. Continuing to use the Service after a change takes effect means you
            accept the updated Terms.
          </p>

          <H2>14. Governing law and jurisdiction</H2>
          <p>
            This Agreement shall be governed by and construed in accordance with the laws
            of Romania. Any dispute arising out of or relating to these Terms shall be
            subject to the exclusive jurisdiction of the competent courts of Bucharest,
            Romania, without prejudice to any mandatory consumer protections available
            in your country of residence.
          </p>

          <H2>15. Contact</H2>
          <p>
            Questions about these Terms:{' '}
            <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </div>
      </main>
      <MarketingFooter />
    </div>
  )
}
