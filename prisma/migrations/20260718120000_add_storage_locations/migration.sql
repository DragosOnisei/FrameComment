-- 4.2.0 (Phase 2b): track every backend a file physically lives on.
--
-- After a "transfer + keep source" the same file exists on two backends at
-- once (e.g. local AND aws). `storageLocations` is a comma-separated list of
-- all backends holding a copy, used for display (two tags in the video info).
-- Reads/playback still resolve via `storageBackend` (the active/target
-- backend). NULL = single location (== storageBackend), i.e. legacy behaviour.

ALTER TABLE "Video" ADD COLUMN "storageLocations" TEXT;
ALTER TABLE "VideoAsset" ADD COLUMN "storageLocations" TEXT;
ALTER TABLE "ProjectUpload" ADD COLUMN "storageLocations" TEXT;
ALTER TABLE "FolderDocument" ADD COLUMN "storageLocations" TEXT;
