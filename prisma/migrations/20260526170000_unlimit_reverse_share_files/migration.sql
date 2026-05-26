-- 1.5.8+: lift the reverse-share per-session file cap from 10 to
-- "effectively unlimited" (99999). The admin Security tab no longer
-- surfaces a control for this — operator wants clients to be able
-- to submit as many files per session as they need.
--
-- Bumps the column default for newly created Settings rows, and
-- backfills any existing row whose value is still the legacy 10
-- (i.e. an admin never raised it manually) so they don't keep
-- hitting the old cap after this release.

ALTER TABLE "Settings" ALTER COLUMN "maxReverseShareFiles" SET DEFAULT 99999;
UPDATE "Settings" SET "maxReverseShareFiles" = 99999 WHERE "maxReverseShareFiles" = 10;
