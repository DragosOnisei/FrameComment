-- 7.19.0: every video gets an ID — "FC<n>", FC1 for the company's first
-- upload, FC2 for the next, one per file, in upload order, never reused.
--
-- Additive and idempotent, per the project rule: every statement guards
-- with IF NOT EXISTS / OR REPLACE so a re-run is a no-op.
--
-- The number is assigned by Postgres, not by the app: a BEFORE INSERT
-- trigger draws the next value from a per-company counter row. The counter
-- upsert (INSERT … ON CONFLICT DO UPDATE … RETURNING) takes a row lock on
-- the company's counter, so two uploads landing in the same instant queue
-- on it and get consecutive numbers; the unique index below is the
-- guarantee that no two videos of one company ever share one. Doing it in
-- a trigger means the two create sites today (POST /api/videos and the
-- duplicate route) and any future one are covered without knowing about it.
--
-- Scope, by Dragos's decisions (2026-10-29): one ID per uploaded file (each
-- version has its own), numbered per company (not across the platform),
-- VIDEO rows only (images, audio and documents stay NULL), existing videos
-- numbered retroactively by createdAt. A legacy row without an
-- organizationId cannot be numbered against a company and stays NULL —
-- that is the truth about it.

ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "fcNumber" INTEGER;

CREATE TABLE IF NOT EXISTS "VideoFcCounter" (
    "organizationId" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "VideoFcCounter_pkey" PRIMARY KEY ("organizationId")
);

-- A tenant table (it carries organizationId): same row-level security as
-- the rest, enabled AND forced, with the standard policy. The app role only
-- ever reaches it through the trigger, during an insert into "Video" whose
-- organizationId is the armed one, so the policy passes. The security scan
-- flags any organizationId-bearing table without RLS as CRITICAL.
ALTER TABLE "VideoFcCounter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VideoFcCounter" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'VideoFcCounter' AND policyname = 'org_isolation'
    ) THEN
        CREATE POLICY "org_isolation" ON "VideoFcCounter"
            USING ("organizationId" = current_setting('app.current_organization_id', true))
            WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));
    END IF;
END
$$;
-- Explicit grant, like TeamInvite: default privileges cover tables created
-- by the migration role, but a grant that is written down cannot be missed.
GRANT SELECT, INSERT, UPDATE, DELETE ON "VideoFcCounter" TO framecomment_app;

-- The trigger function. SECURITY INVOKER (the default): it runs as the role
-- inserting the video, under that role's RLS context — nothing here needs
-- to see another company's rows.
CREATE OR REPLACE FUNCTION assign_video_fc_number()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."fcNumber" IS NULL
       AND NEW."organizationId" IS NOT NULL
       AND NEW."mediaType" = 'VIDEO' THEN
        INSERT INTO "VideoFcCounter" ("organizationId", "lastNumber")
        VALUES (NEW."organizationId", 1)
        ON CONFLICT ("organizationId")
        DO UPDATE SET "lastNumber" = "VideoFcCounter"."lastNumber" + 1
        RETURNING "lastNumber" INTO NEW."fcNumber";
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS video_assign_fc_number ON "Video";
CREATE TRIGGER video_assign_fc_number
    BEFORE INSERT ON "Video"
    FOR EACH ROW
    EXECUTE FUNCTION assign_video_fc_number();

-- Retroactive numbering: every existing VIDEO row of every company, in
-- upload order (createdAt, then id for two rows with the same stamp), rows
-- in the Trash included — a trashed video keeps its number so a later one
-- cannot inherit it. Only rows still NULL are touched, so a re-run of this
-- migration changes nothing.
UPDATE "Video" v
SET "fcNumber" = numbered.n
FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY "organizationId" ORDER BY "createdAt", id) AS n
    FROM "Video"
    WHERE "organizationId" IS NOT NULL AND "mediaType" = 'VIDEO'
) AS numbered
WHERE v.id = numbered.id AND v."fcNumber" IS NULL;

-- Start every company's counter at its highest number, so the next upload
-- continues the sequence instead of colliding with the backfill.
INSERT INTO "VideoFcCounter" ("organizationId", "lastNumber")
SELECT "organizationId", COALESCE(MAX("fcNumber"), 0)
FROM "Video"
WHERE "organizationId" IS NOT NULL
GROUP BY "organizationId"
ON CONFLICT ("organizationId")
DO UPDATE SET "lastNumber" = GREATEST("VideoFcCounter"."lastNumber", EXCLUDED."lastNumber");

-- The guarantee. Postgres treats NULLs as distinct, so unnumbered rows
-- (images, audio, documents, legacy rows without a company) never collide.
CREATE UNIQUE INDEX IF NOT EXISTS "Video_organizationId_fcNumber_key"
    ON "Video"("organizationId", "fcNumber");
