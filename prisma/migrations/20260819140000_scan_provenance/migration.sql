-- 6.18.1 — say how long a scan took, how much it could not check, and where.
--
-- A scan that finishes in under a second invites the reasonable question "did
-- that actually do anything?". Pass/warn/fail counts cannot answer it: a run
-- with 34 checks and no skips looks identical to one where most stages bailed
-- out. And a scan of a developer laptop is not evidence about production, so
-- the run records which installation it described.
ALTER TABLE "SecurityScan"
  ADD COLUMN IF NOT EXISTS "skipped"     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "durationMs"  INTEGER,
  ADD COLUMN IF NOT EXISTS "environment" TEXT;
