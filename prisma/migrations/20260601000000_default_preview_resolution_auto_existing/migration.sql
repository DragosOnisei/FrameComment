-- 2.0.x+: the 2.0.4 release fixed the API and UI fallbacks so they
-- default to "auto" instead of the legacy "720p" cap, but the
-- previously created `Settings` row(s) still hold "720p" on disk.
-- The Global Settings UI therefore continues to show "720p" until
-- the user manually re-saves to "Auto".
--
-- Normalize: any existing Settings row that's still on the legacy
-- "720p" implicit default flips to "auto" so the UI matches the
-- new in-code default. Users who *deliberately* chose "1080p" or
-- "2160p" are untouched.
--
-- This is a one-way nudge — admins who actually wanted the 720p
-- ceiling can pick it again from Settings → Video Processing.
UPDATE "Settings"
   SET "defaultPreviewResolution" = 'auto'
 WHERE "defaultPreviewResolution" = '720p'
    OR "defaultPreviewResolution" IS NULL;
