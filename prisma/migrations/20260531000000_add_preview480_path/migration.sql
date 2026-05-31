-- 1.9.4+ Phase A: add the 480p tier column so the worker can
-- park the fastest progressive preview here without colliding
-- with the larger 720p/1080p/2160p tiers.
ALTER TABLE "Video" ADD COLUMN "preview480Path" TEXT;
