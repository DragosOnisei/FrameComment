-- 2.2.0+: breadth-first encoding pipeline tier tracking.
--
-- The old single-job `process-video` did every tier (480→720→
-- 1080→2160) for ONE video before moving to the next. On bulk
-- uploads of 100 files the last video waited for the previous 99
-- to fully finish before even getting a 480p — terrible UX.
--
-- 2.2.0 splits the pipeline into 3 jobs on the same queue:
--   1. `prepare-video`  (priority 1)
--   2. `encode-tier`    (priority 10/50/100/200 by tier)
--   3. `finalize-video` (priority 500)
--
-- `prepare-video` populates `plannedTiers` from the source probe
-- and the project's `previewResolution`. Each `encode-tier`
-- success appends its tier to `completedTiers`. `finalize-video`
-- waits until lengths match (or 30 min timeout, then re-queues
-- itself with delay).
--
-- Both columns are nullable + default NULL so pre-2.2.0 rows
-- continue to work unchanged. The runtime treats a NULL
-- `plannedTiers` as "legacy row — read the preview*Path columns
-- + status directly", which is exactly what the pre-2.2.0 code
-- already did.
ALTER TABLE "Video"
  ADD COLUMN "plannedTiers" JSONB,
  ADD COLUMN "completedTiers" JSONB;
