-- 6.25.0 — why a company chose to leave, if they chose to say.
--
-- One nullable column. No default and no backfill: a deletion scheduled before
-- this release has no recorded reason, and NULL says exactly that, where an
-- empty string would look like somebody was asked and declined.
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "deletionReason" TEXT;
