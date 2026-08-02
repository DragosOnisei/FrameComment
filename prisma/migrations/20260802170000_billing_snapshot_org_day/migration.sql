-- 5.7 Multi-Tenant Phase 5: per-organization billing snapshots.
--
-- BillingSnapshot.day was globally UNIQUE from the single-tenant era — the
-- second company's daily snapshot on the same day would violate it. Move
-- uniqueness to (organizationId, day): one snapshot per day PER COMPANY.
-- Existing rows all belong to org-1 (backfilled in 5.0), so the new
-- composite index cannot conflict.

DROP INDEX IF EXISTS "BillingSnapshot_day_key";

CREATE UNIQUE INDEX "BillingSnapshot_organizationId_day_key"
    ON "BillingSnapshot"("organizationId", "day");
