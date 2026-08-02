-- 5.10 Danger Zone: company deletion countdown + anti-mass-wipe throttle.
--
--  * deletionScheduledAt: server-side 30-day countdown anchor. The worker
--    wipes the organization (row delete -> FK cascade across all tenant
--    tables) only once NOW passes it; clients cannot influence the clock.
--  * deletionRequestedById: audit — which Owner initiated it.
--  * lastProjectTrashedAt: tenants may trash at most ONE project per 24h,
--    and purge it from Trash only 24h later — a compromised account cannot
--    rapidly destroy a company's work.

ALTER TABLE "Organization" ADD COLUMN "deletionScheduledAt" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN "deletionRequestedById" TEXT;
ALTER TABLE "Organization" ADD COLUMN "lastProjectTrashedAt" TIMESTAMP(3);

CREATE INDEX "Organization_deletionScheduledAt_idx"
    ON "Organization"("deletionScheduledAt");
