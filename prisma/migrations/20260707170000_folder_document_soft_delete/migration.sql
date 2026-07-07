-- 3.9.x: soft-delete for FolderDocument so deleting a transcript PDF
-- moves it to Trash (restorable) instead of hard-deleting it.

ALTER TABLE "FolderDocument" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "FolderDocument_deletedAt_idx" ON "FolderDocument"("deletedAt");
