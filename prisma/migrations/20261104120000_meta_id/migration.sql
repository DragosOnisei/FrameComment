-- 7.20.0: the FC number moves from the FILE to the Meta AD.
--
-- 7.19.0 numbered every uploaded video. Marketing could not use that: Meta
-- runs every size of one edit (9:16, 4:5, 1:1, 16:9) as ONE ad, so the
-- sizes need one code, and CPC keeps exactly that unit as a folder — one
-- folder per ad, a subfolder per ratio. A naming-convention matcher was
-- built and dropped before release: file names vary too much between
-- projects. So the ID is now the FOLDER's, given on demand by a person
-- (right-click → Generate Meta ID), and every video under the folder
-- carries it. By Dragos's decision (2026-11-04) the per-file IDs are
-- deleted and Meta IDs start again at FC1.

ALTER TABLE "Folder" ADD COLUMN IF NOT EXISTS "metaNumber" INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS "Folder_organizationId_metaNumber_key"
    ON "Folder"("organizationId", "metaNumber");

-- Retire the per-file numbering: no trigger, no numbers. The column and
-- its unique index stay (additive migrations); every value is NULL.
DROP TRIGGER IF EXISTS video_assign_fc_number ON "Video";
DROP FUNCTION IF EXISTS assign_video_fc_number();
UPDATE "Video" SET "fcNumber" = NULL WHERE "fcNumber" IS NOT NULL;

-- The same per-company counter now hands out Meta IDs, from FC1.
UPDATE "VideoFcCounter" SET "lastNumber" = 0;

-- 7.19.0 created the counter without the ON DELETE CASCADE key to
-- Organization that every tenant table carries (src/worker/org-deletion.ts
-- relies on it to wipe a company in one delete).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VideoFcCounter_organizationId_fkey') THEN
        ALTER TABLE "VideoFcCounter" ADD CONSTRAINT "VideoFcCounter_organizationId_fkey"
            FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;
