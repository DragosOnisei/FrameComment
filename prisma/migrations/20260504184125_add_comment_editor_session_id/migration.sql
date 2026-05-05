-- DropForeignKey
ALTER TABLE "ProjectUpload" DROP CONSTRAINT "ProjectUpload_projectId_fkey";

-- DropIndex
DROP INDEX "Project_dueDate_idx";

-- DropIndex
DROP INDEX "Video_projectId_status_idx";

-- DropIndex
DROP INDEX "Video_status_idx";

-- AlterTable
ALTER TABLE "Comment" ADD COLUMN     "editorSessionId" TEXT;

-- AlterTable
ALTER TABLE "EmailTemplate" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PasskeyCredential" ALTER COLUMN "transports" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Project" ALTER COLUMN "clientNotificationSchedule" SET DEFAULT 'HOURLY';

-- AlterTable
ALTER TABLE "ProjectUpload" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PushSubscription" ALTER COLUMN "subscribedEvents" SET DEFAULT ARRAY['SHARE_ACCESS', 'ADMIN_ACCESS', 'CLIENT_COMMENT', 'VIDEO_APPROVAL', 'CLIENT_UPLOAD', 'SECURITY_ALERT']::TEXT[];

-- AlterTable
ALTER TABLE "SecuritySettings" ALTER COLUMN "ipRateLimit" SET DEFAULT 1000,
ALTER COLUMN "sessionRateLimit" SET DEFAULT 600;

-- AlterTable
ALTER TABLE "Settings" ALTER COLUMN "adminNotificationSchedule" SET DEFAULT 'HOURLY';

-- AlterTable
ALTER TABLE "Video" ALTER COLUMN "name" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "ProjectUpload" ADD CONSTRAINT "ProjectUpload_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
