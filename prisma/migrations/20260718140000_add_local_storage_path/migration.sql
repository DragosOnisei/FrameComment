-- 4.2.0 (Phase 2d): configurable uploads folder for the Local Storage backend.
--
-- NULL = use the STORAGE_ROOT env var (default, unchanged behaviour). When set
-- (via the "Local Storage" dialog in Settings), new local uploads are written
-- under this path; files already stored under STORAGE_ROOT stay readable — the
-- storage layer falls back to the env root on read.

ALTER TABLE "Settings" ADD COLUMN "localStoragePath" TEXT;
