-- 6.1.0 — explicit version-stack identity.
--
-- Version membership used to be inferred from `Video.name`. That failed both
-- ways: an upload whose filename matched a live stack joined it while keeping
-- the v1 it was created with (so a 4th version displayed as V1), and a split
-- left rows carrying whatever number they had (a lone video showing V4).
--
-- From here on: a stack is `stackId`, `name` is purely cosmetic, and
-- `version` is the row's POSITION inside its stack.

ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "stackId" TEXT;

-- Backfill: the pre-6.1.0 grouping rule was (projectId, folderId, name), so
-- derive one deterministic stackId per existing group. Trashed rows keep the
-- same stackId as their live siblings, which is what restore expects.
UPDATE "Video"
SET "stackId" = 'stk_' || md5("projectId" || '|' || COALESCE("folderId", '~root') || '|' || "name")
WHERE "stackId" IS NULL;

CREATE INDEX IF NOT EXISTS "Video_stackId_idx" ON "Video"("stackId");

-- One-time repair of the damage the old numbering left behind: renumber every
-- LIVE stack 1..N in upload order. Existing stacks were built chronologically,
-- so createdAt is the correct order here; from now on the app maintains the
-- position explicitly (a video stacked later goes last even if it is older).
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (PARTITION BY "stackId" ORDER BY "createdAt" ASC, "id" ASC) AS rn
  FROM "Video"
  WHERE "deletedAt" IS NULL AND "stackId" IS NOT NULL
)
UPDATE "Video" v
SET "version" = r.rn,
    "versionLabel" = 'v' || r.rn
FROM ranked r
WHERE v."id" = r."id"
  AND v."version" <> r.rn;
