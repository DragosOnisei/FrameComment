import Stripe from 'stripe'

/**
 * 3.7.0+: Stripe integration.
 *
 * The platform (your company) has a SINGLE Stripe account that
 * receives all payments. Its keys live in env vars — never in the DB
 * and never shipped to the client:
 *
 *   STRIPE_SECRET_KEY      sk_test_… (sandbox) → sk_live_… later
 *   STRIPE_PUBLISHABLE_KEY pk_test_… (only needed if we ever mount
 *                          Stripe.js on the client; Checkout redirect
 *                          doesn't strictly need it)
 *   STRIPE_WEBHOOK_SECRET  whsec_…   (verifies webhook signatures)
 *
 * Everything here is a no-op when STRIPE_SECRET_KEY is absent, so the
 * app runs fine before billing is wired up on a given deployment.
 */

let cached: Stripe | null = null

export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return null
  if (cached) return cached
  // No explicit apiVersion — the installed SDK pins its own default,
  // which keeps types + behaviour in sync with this package version.
  cached = new Stripe(key, {
    appInfo: { name: 'FrameComment' },
  })
  return cached
}

export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY
}

export function getStripePublishableKey(): string | null {
  return process.env.STRIPE_PUBLISHABLE_KEY || null
}

export function getStripeWebhookSecret(): string | null {
  return process.env.STRIPE_WEBHOOK_SECRET || null
}

/**
 * Whether we're pointed at a Stripe TEST/sandbox key. Handy for the
 * UI to badge "Test mode" so nobody thinks a sandbox charge is real.
 */
export function isStripeTestMode(): boolean {
  return (process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_')
}
