-- 6.24.0 — where a share link was opened from.
--
-- Two nullable columns and one index. Nullable rather than defaulted, and
-- deliberately not backfilled: an open recorded before this release has no
-- country, and inventing one from a present-day lookup of a stored IP would
-- record a guess as if it were an observation.
ALTER TABLE "SharePageAccess" ADD COLUMN IF NOT EXISTS "country" TEXT;
ALTER TABLE "SharePageAccess" ADD COLUMN IF NOT EXISTS "countryName" TEXT;

-- The founder Security page reads the newest opens across every project, and
-- the 90-day purge deletes the oldest. Both scan by date alone; the existing
-- indexes all lead with projectId and cannot serve either.
CREATE INDEX IF NOT EXISTS "SharePageAccess_createdAt_idx" ON "SharePageAccess"("createdAt");
