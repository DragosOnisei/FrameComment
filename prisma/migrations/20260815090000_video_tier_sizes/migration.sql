-- 6.9.0 — byte size per encoded tier, for the download-resolution menu.
--
-- Recorded when a tier finishes encoding. Existing rows stay NULL and are
-- measured from storage the first time the menu asks for them, then written
-- back — so old videos get their sizes without a re-encode.

ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "preview2160Size" BIGINT;
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "preview1080Size" BIGINT;
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "preview720Size" BIGINT;
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "preview480Size" BIGINT;
