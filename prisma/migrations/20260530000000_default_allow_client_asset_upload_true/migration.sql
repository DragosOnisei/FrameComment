-- 1.9.1+: attachments enabled by default for every project.
-- 1. Change the column default to true for projects created from now on.
-- 2. Flip every project that still has the old default (false) to true.
--    Admins who actively disabled attachments on a specific project lose that
--    choice during this one-time migration — they can re-disable from
--    Project Settings. We accept this trade-off because the prior default
--    was confusing in practice (silent "not enabled" error on the share
--    page) and the user's intent is "always on by default".

ALTER TABLE "Project" ALTER COLUMN "allowClientAssetUpload" SET DEFAULT true;

UPDATE "Project" SET "allowClientAssetUpload" = true WHERE "allowClientAssetUpload" = false;
