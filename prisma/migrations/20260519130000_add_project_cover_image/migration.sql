-- 1.2.0: optional cover image path on Project. Stored as a path within
-- the storage abstraction. Null means the dashboard renders the
-- deterministic gradient instead.

ALTER TABLE "Project"
ADD COLUMN "coverImagePath" TEXT;
