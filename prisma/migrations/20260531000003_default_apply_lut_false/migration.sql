-- 1.9.4+ Phase A: switch the default for `applyPreviewLut` to
-- false. The LUT filter was a major CPU sink — running at INPUT
-- resolution before the downscale, adding 30-60s per tier on a
-- 40-min 1080p source. Default-off matches what users actually
-- want from the progressive ladder (fast iteration over
-- color-calibrated accuracy). Existing projects that still want
-- the LUT can keep their explicit `true` value.
ALTER TABLE "Project" ALTER COLUMN "applyPreviewLut" SET DEFAULT false;

-- Flip every existing project too so the global "off" intent
-- applies retroactively. Per-project override stays available
-- via the Project Settings UI for the rare LUT-on workflow.
UPDATE "Project" SET "applyPreviewLut" = false;
