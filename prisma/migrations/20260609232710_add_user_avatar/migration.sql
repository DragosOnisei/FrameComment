-- AlterTable
ALTER TABLE "SecuritySettings" ALTER COLUMN "adminSessionTimeoutValue" SET DEFAULT 12,
ALTER COLUMN "adminSessionTimeoutUnit" SET DEFAULT 'HOURS';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "avatarUrl" TEXT;
