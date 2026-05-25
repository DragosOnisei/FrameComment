-- 1.5.x+: lift the default upload-size cap from 1 GB to 1000 GB (1 TB).
--
-- Two changes:
--   1. Update the column DEFAULT so any *new* Settings row starts at
--      1000 GB instead of the legacy 1 GB.
--   2. Bump any existing row that still has the legacy default value
--      of `1` so the upgrade isn't a no-op on running deployments.
--
-- Rows where the admin explicitly picked a higher (or lower) value are
-- left alone — we only touch rows still sitting at the OLD default,
-- which we treat as an implicit "I never bothered to change this".

ALTER TABLE "Settings"
  ALTER COLUMN "maxUploadSizeGB" SET DEFAULT 1000;

UPDATE "Settings"
SET "maxUploadSizeGB" = 1000
WHERE "maxUploadSizeGB" = 1;
