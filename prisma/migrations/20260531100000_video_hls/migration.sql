-- 1.9.4+ Phase B: HLS adaptive-streaming variants. The worker
-- remuxes each MP4 tier into HLS segments + playlist after the
-- tier completes (no re-encoding cost — just splits existing
-- bytes). The dynamic master.m3u8 served by the API lists only
-- the qualities present in `hlsQualities`, so when a higher
-- tier lands mid-playback the next manifest poll picks it up
-- and hls.js / Safari auto-upgrade without seeking back.
ALTER TABLE "Video" ADD COLUMN "hlsBasePath" TEXT;
ALTER TABLE "Video" ADD COLUMN "hlsQualities" TEXT[] DEFAULT ARRAY[]::TEXT[];
