-- 3.7.0+: Stripe billing fields on the singleton Settings row.
--
-- Single-account platform model: all payments land in the company's
-- one Stripe account (keys in env vars). These columns track the
-- instance's Stripe Customer, the saved card (brand/last4 for display
-- only — never the PAN), the billing status, the next automatic charge
-- date, and a snapshot of the most recent invoice.
--
-- All nullable except billingStatus, which defaults to 'none' so
-- existing rows read as "no billing set up yet".

ALTER TABLE "Settings" ADD COLUMN "stripeCustomerId"   TEXT;
ALTER TABLE "Settings" ADD COLUMN "billingEmail"       TEXT;
ALTER TABLE "Settings" ADD COLUMN "paymentMethodBrand" TEXT;
ALTER TABLE "Settings" ADD COLUMN "paymentMethodLast4" TEXT;
ALTER TABLE "Settings" ADD COLUMN "billingStatus"      TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "Settings" ADD COLUMN "billingAnchorDay"   INTEGER;
ALTER TABLE "Settings" ADD COLUMN "nextBillingAt"      TIMESTAMP(3);
ALTER TABLE "Settings" ADD COLUMN "lastInvoiceId"      TEXT;
ALTER TABLE "Settings" ADD COLUMN "lastInvoiceAmount"  INTEGER;
ALTER TABLE "Settings" ADD COLUMN "lastInvoiceStatus"  TEXT;
ALTER TABLE "Settings" ADD COLUMN "lastChargedAt"      TIMESTAMP(3);
