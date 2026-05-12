-- Add Video.createdById so each upload can be attributed to an admin.
-- Nullable + ON DELETE SET NULL: removing an admin user must not
-- orphan their uploaded videos.
ALTER TABLE "Video" ADD COLUMN "createdById" TEXT;

-- Foreign key + index match the pattern used for Folder.createdById.
ALTER TABLE "Video"
  ADD CONSTRAINT "Video_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Video_createdById_idx" ON "Video"("createdById");
