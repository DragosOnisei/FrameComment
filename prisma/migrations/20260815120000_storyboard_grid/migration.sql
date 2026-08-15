-- 6.9.3 — per-video storyboard sprite geometry.
--
-- The hover-scrub sprite was a fixed 10x10 grid for every video. On a
-- 7-minute clip that is one sampled frame every 4.2 seconds, so the preview
-- under the cursor could be ~2 seconds away from where a click actually
-- landed. The grid now scales with duration, which means the reader can no
-- longer assume 10x10 — it has to know what was produced.
--
-- NULL means "generated before 6.9.3", which is exactly 10x10.

ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "storyboardCols" INTEGER;
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "storyboardRows" INTEGER;
