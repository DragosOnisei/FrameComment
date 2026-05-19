-- 1.2.0: soft-delete on Project. Matches the existing Video / Folder
-- pattern so the cleanup cron can hard-delete a project that's been
-- in Trash longer than TRASH_RETENTION_DAYS (30 days).

ALTER TABLE "Project" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "Project_deletedAt_idx" ON "Project"("deletedAt");
