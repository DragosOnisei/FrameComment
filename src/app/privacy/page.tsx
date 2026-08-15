import type { Metadata } from 'next'
import { MarketingNav } from '@/components/marketing/MarketingNav'
import { MarketingFooter } from '@/components/marketing/MarketingFooter'

/**
 * 5.14.0, Privacy Policy for the FrameComment service.
 *
 * GDPR-oriented, written for what THIS product actually does (no ad
 * trackers, no data sales, no AI training on customer content).
 * Data controller details supplied by the owner: MINDQUB S.R.L.
 */

export const metadata: Metadata = {
  title: 'Privacy Policy — FrameComment',
  description:
    'How FrameComment collects, uses and protects your data. GDPR-oriented, no ad trackers, no data sales, and customer content is never used to train AI models.',
  alternates: { canonical: '/privacy' },
  robots: { index: true, follow: true },
  openGraph: {
    type: 'website',
    url: '/privacy',
    siteName: 'FrameComment',
    title: 'Privacy Policy — FrameComment',
    description: 'How FrameComment collects, uses and protects your data.',
  },
}

const EFFECTIVE_DATE = 'August 4, 2026'
const CONTACT_EMAIL = 'dragos.onisei@mindqub.eu'

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="text-xl font-semibold text-white mt-10 mb-3">{children}</h2>
}

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <MarketingNav />
      <main className="mx-auto max-w-3xl px-4 sm:px-6 py-14">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary mb-3">
          Legal
        </p>
        <h1 className="text-3xl sm:text-4xl font-bold text-white">Privacy Policy</h1>
        <p className="mt-3 text-sm text-white/45">Last updated: {EFFECTIVE_DATE}</p>

        <div className="mt-8 space-y-4 text-[15px] leading-relaxed text-white/70">
          <p>
            This policy explains how FrameComment handles personal data, what we
            collect, why, and the rights you have. We built the Service for
            professional video work, and our approach is simple: your content is your
            business. We don&rsquo;t sell data, we don&rsquo;t run advertising, and we
            don&rsquo;t use your content to train AI models.
          </p>

          <H2>1. Data controller</H2>
          <p>
            <strong className="text-white">MINDQUB S.R.L.</strong>
            <br />
            Strada Vespasian nr. 47, Camera 2
            <br />
            Sector 1, București 011981, Romania
            <br />
            Company Registration No.: J2025022239001 · VAT / Tax ID: RO51533881
            <br />
            Contact:{' '}
            <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">
              {CONTACT_EMAIL}
            </a>
          </p>
          <p>
            Note: when a company uses FrameComment to collaborate with its own clients
            and team, that company decides what content is uploaded and shared. For the
            content of those projects, the company acts as the data controller and
            MINDQUB S.R.L. processes it on the company&rsquo;s behalf to provide the
            Service.
          </p>

          <H2>2. What we collect</H2>
          <p>
            <strong className="text-white">Account data.</strong> Name, email address,
            and a password (stored only as a cryptographic hash, we never see or store
            the plain password). If you sign in with a passkey, we store the passkey&rsquo;s
            public credential, never a private key.
          </p>
          <p>
            <strong className="text-white">Content you upload.</strong> Videos, images,
            documents, comments (including voice comments and attachments), project and
            and folder names. Guest reviewers on share links may
            leave a display name with their comments.
          </p>
          <p>
            <strong className="text-white">Billing data.</strong> Your company name,
            billing status and invoices. Card details are collected and processed
            directly by Stripe, they never touch our servers.
          </p>
          <p>
            <strong className="text-white">Usage and security logs.</strong> IP
            addresses, browser type, and security-relevant events (sign-ins, failed
            attempts, destructive actions). We use these to keep accounts safe, enforce
            rate limits and investigate abuse.
          </p>
          <p>
            <strong className="text-white">Cookies and local storage.</strong> We use
            only what is strictly necessary to operate the Service, session
            authentication and interface preferences (like your accent color). There
            are no advertising or cross-site tracking cookies.
          </p>

          <H2>3. Why we process it (legal bases)</H2>
          <p>
            We process personal data to provide the Service you signed up for
            (performance of a contract, Art. 6(1)(b) GDPR); to keep the Service secure,
            prevent abuse and improve reliability (legitimate interest, Art. 6(1)(f));
            to meet legal obligations such as tax and accounting rules (Art. 6(1)(c));
            and, where we ever ask for it, based on your consent (Art. 6(1)(a)), which
            you can withdraw at any time.
          </p>

          <H2>4. AI transcription</H2>
          <p>
            Transcripts are generated only when someone on your team explicitly requests
            one. In that case the audio of the selected video is sent to our AI
            transcription provider (currently OpenAI) solely to produce the transcript;
            the result is stored in your project as a document you can delete at any
            time. If you never request a transcript, your media is never sent to an AI
            provider.
          </p>

          <H2>5. Who we share data with</H2>
          <p>
            We do not sell or rent personal data. We share it only with processors that
            help us run the Service: Stripe (payments), our AI transcription provider
            (only on request, as above), and infrastructure providers for hosting and
            delivery. If your company connects its own storage backend (your server,
            Cloudflare R2, AWS S3), files stored there sit with the provider your
            company chose, under your company&rsquo;s agreement with them. We may also
            disclose data where the law requires it, or to protect the rights and
            safety of our users and the Service.
          </p>

          <H2>6. International transfers</H2>
          <p>
            We aim to keep data within the European Economic Area. Some processors (for
            example Stripe and OpenAI) may process data in the United States; where that
            happens, transfers are protected by recognized safeguards such as the EU
            Standard Contractual Clauses or an adequacy framework.
          </p>

          <H2>7. How long we keep data</H2>
          <p>
            Account and content data are kept for as long as your company account is
            active. Deleted projects and files spend up to 30 days in a recoverable
            Trash, then are permanently removed. Deleting a company starts a 30-day
            cancellable countdown, after which the company&rsquo;s data is permanently
            erased. Billing and invoicing records are retained for the periods required
            by Romanian fiscal law. Security logs are kept for a limited period needed
            to investigate abuse.
          </p>

          <H2>8. Security</H2>
          <p>
            All traffic is encrypted in transit (HTTPS/HSTS). Passwords are hashed;
            stored credentials for connected storage are encrypted at rest. Each
            company&rsquo;s data is isolated at the database level using PostgreSQL
            row-level security, and destructive actions are protected by confirmations
            and time-delayed safety windows. No system is perfectly secure, but we treat
            security as a first-class feature and ship protections continuously.
          </p>

          <H2>9. Your rights</H2>
          <p>
            Under the GDPR you have the right to access, rectify, delete, restrict or
            object to the processing of your personal data, and the right to data
            portability. For any privacy-related requests, including access,
            rectification, deletion, or portability of your personal data, please
            contact:{' '}
            <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">
              {CONTACT_EMAIL}
            </a>
            . We respond within the timelines required by law. You also have the right
            to lodge a complaint with a supervisory authority, in Romania, that is
            ANSPDCP (Autoritatea Națională de Supraveghere a Prelucrării Datelor cu
            Caracter Personal, www.dataprotection.ro).
          </p>

          <H2>10. Children</H2>
          <p>
            The Service is intended for professional use and is not directed at children
            under 16. We do not knowingly collect personal data from children; if you
            believe a child has provided us personal data, contact us and we will delete
            it.
          </p>

          <H2>11. Changes to this policy</H2>
          <p>
            If we change this policy in a material way, we will update the date above
            and notify active users before the change takes effect.
          </p>
        </div>
      </main>
      <MarketingFooter />
    </div>
  )
}
