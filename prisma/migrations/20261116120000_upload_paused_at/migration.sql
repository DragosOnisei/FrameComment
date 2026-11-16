-- 7.20.3: a paused upload is not an abandoned one.
--
-- The server sees the same silence from a transfer the uploader paused and
-- one that died, and the 30-minute reaper marked a paused upload Failed —
-- on every colleague's card — until it was resumed and finished. The upload
-- window now records Pause here (NULL = transferring); the reaper gives a
-- paused row 24 hours, the same floor S3 uploads already get. Additive; a
-- row uploaded before this release was never paused, so NULL is the truth.
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "uploadPausedAt" TIMESTAMP(3);
