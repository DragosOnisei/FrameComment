-- 1.9.4+ Phase A: lift the default progressive ladder cap from
-- 720p to 1080p. With the new 480p fast first tier, 720p was an
-- unnecessarily low ceiling — users with 1080p sources expect
-- 1080p in the quality menu after a few minutes of background
-- transcoding. Existing projects keep whatever value they had.
ALTER TABLE "Project" ALTER COLUMN "previewResolution" SET DEFAULT '1080p';
