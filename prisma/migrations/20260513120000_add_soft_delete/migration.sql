-- 1.0.8+: Soft-delete column on Video and Folder.
--
-- Trash UX: deleting a row sets `deletedAt = now()` instead of
-- removing it. A daily cleanup job hard-deletes rows whose
-- `deletedAt` is older than 30 days. Listings filter `deletedAt IS
-- NULL` so callers never have to think about it.
--
-- Index helps the cleanup job (range scan on the timestamp).

ALTER TABLE "Video" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "Video_deletedAt_idx" ON "Video"("deletedAt");

ALTER TABLE "Folder" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "Folder_deletedAt_idx" ON "Folder"("deletedAt");
