-- 4.5.0: add two more content-only roles at level 50.
--
-- SENIOR_VIDEO_EDITOR and TEAM_LEADER behave exactly like EDITOR / MARKETING /
-- PRODUCER (level 50): content rights only, no user management, no
-- Settings / Storage / Billing, and NO special notification behaviour (that's
-- reserved for PROJECT_MANAGER at level 60).
--
-- Only adds enum values; changes no user rows. Idempotent. Postgres 12+.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'SENIOR_VIDEO_EDITOR';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'TEAM_LEADER';
