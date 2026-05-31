-- 1.9.4+ Phase B: per-tier transcode progress map.
--
-- The single `processingProgress` field has the wrong shape for
-- parallel transcoding: two ffmpegs running 720p + 1080p both
-- overwrite it, so the Quality menu's progress badges read
-- whichever raced last (or shows the same number for every
-- pending tier). This new JSONB map gives each tier its own
-- progress key. Worker updates are atomic via `jsonb_set` so
-- concurrent writes don't clobber each other.
ALTER TABLE "Video"
  ADD COLUMN "transcodeProgressByTier" JSONB NOT NULL DEFAULT '{}'::jsonb;
