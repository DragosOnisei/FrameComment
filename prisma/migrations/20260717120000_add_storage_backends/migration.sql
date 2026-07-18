-- 4.2.0: Multi-backend storage.
--
-- Track which backend holds each file (Video / VideoAsset / ProjectUpload
-- / FolderDocument) so files stay readable after the active backend
-- changes. NULL = legacy behaviour (resolve via the STORAGE_PROVIDER env),
-- so every pre-4.2.0 file keeps working with no data migration.
--
-- Settings gains the active backend + the customer's R2 / AWS config
-- (secrets are encrypted at the application layer before being stored).

ALTER TABLE "Settings"
  ADD COLUMN "activeStorageBackend" TEXT,
  ADD COLUMN "r2Endpoint" TEXT,
  ADD COLUMN "r2Region" TEXT DEFAULT 'auto',
  ADD COLUMN "r2Bucket" TEXT,
  ADD COLUMN "r2AccessKeyId" TEXT,
  ADD COLUMN "r2SecretAccessKey" TEXT,
  ADD COLUMN "awsRegion" TEXT DEFAULT 'us-east-1',
  ADD COLUMN "awsBucket" TEXT,
  ADD COLUMN "awsAccessKeyId" TEXT,
  ADD COLUMN "awsSecretAccessKey" TEXT;

ALTER TABLE "Video" ADD COLUMN "storageBackend" TEXT;
ALTER TABLE "VideoAsset" ADD COLUMN "storageBackend" TEXT;
ALTER TABLE "ProjectUpload" ADD COLUMN "storageBackend" TEXT;
ALTER TABLE "FolderDocument" ADD COLUMN "storageBackend" TEXT;
