-- 3.8.0+: usage metering + dunning.
--
-- BillingSnapshot: one row per calendar day (user count + storage
-- bytes) so the monthly invoice can average over the period and
-- prorate mid-period changes.
--
-- Settings.billingIssueSince / billingSuspended: the dunning clock.
-- When a payment fails or the instance goes over the free tier without
-- a card, `billingIssueSince` is stamped; after 5 business days the
-- daily job sets `billingSuspended`, which raises the admin billing
-- wall (client share links are unaffected). Both clear on resolution.

CREATE TABLE "BillingSnapshot" (
  "id"           TEXT NOT NULL,
  "day"          TIMESTAMP(3) NOT NULL,
  "userCount"    INTEGER NOT NULL,
  "storageBytes" BIGINT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BillingSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingSnapshot_day_key" ON "BillingSnapshot"("day");

ALTER TABLE "Settings" ADD COLUMN "billingIssueSince" TIMESTAMP(3);
ALTER TABLE "Settings" ADD COLUMN "billingSuspended"  BOOLEAN NOT NULL DEFAULT false;
