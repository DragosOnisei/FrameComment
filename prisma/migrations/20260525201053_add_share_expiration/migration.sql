-- DropIndex
DROP INDEX "Project_deletedAt_idx";

-- AlterTable
ALTER TABLE "Folder" ADD COLUMN     "shareExpiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "shareExpiresAt" TIMESTAMP(3);
