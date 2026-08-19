-- 6.20.0 — full scan vs daily scan.
--
-- The two are not comparable. Diffing a daily run against a full one would
-- report every full-only check as newly resolved, then newly broken again on
-- the next weekly run — an alert that cries wolf on a fixed schedule.
ALTER TABLE "SecurityScan" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'FULL';
CREATE INDEX IF NOT EXISTS "SecurityScan_kind_startedAt_idx" ON "SecurityScan"("kind", "startedAt");
