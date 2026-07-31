-- 4.7.x data backfill: restore full video display names.
--
-- Before the name cap was raised from 50 to 200, uploads via the picker
-- stored the display `name` truncated to the first 50 characters of the
-- filename (extension stripped). The FULL name still lives in
-- `originalFileName` (that's why downloads show the complete name). This
-- one-time backfill rewrites the truncated `name` back to the full base
-- name derived from `originalFileName`.
--
-- Safety:
--   * Only touches rows whose `name` is EXACTLY 50 chars (the old cap) AND
--     whose `originalFileName` base (extension stripped) is strictly longer
--     AND begins with that exact 50-char prefix. A genuinely 50-char name
--     equals its base (not a strict prefix), so it is never touched.
--   * Group-safe: every version in a stack shares the same `name`; we pick
--     ONE representative full base per (projectId, folderId, name) group —
--     the longest matching base — and set the whole group to it, so version
--     stacks stay intact (they keep sharing one common name).
--   * Runs once (tracked by Prisma migrations) and skips soft-deleted rows.

WITH candidates AS (
  SELECT
    "projectId",
    "folderId",
    "name",
    regexp_replace("originalFileName", '\.[^.]*$', '') AS base
  FROM "Video"
  WHERE char_length("name") = 50
    AND "originalFileName" IS NOT NULL
    AND "deletedAt" IS NULL
),
reps AS (
  SELECT DISTINCT ON ("projectId", "folderId", "name")
    "projectId",
    "folderId",
    "name",
    base AS full_base
  FROM candidates
  WHERE char_length(base) > 50
    AND left(base, 50) = "name"
  ORDER BY "projectId", "folderId", "name", char_length(base) DESC
)
UPDATE "Video" v
SET "name" = reps.full_base
FROM reps
WHERE v."projectId" IS NOT DISTINCT FROM reps."projectId"
  AND v."folderId" IS NOT DISTINCT FROM reps."folderId"
  AND v."name" = reps."name"
  AND char_length(v."name") = 50;
