-- 6.13.0 — admin inactivity window becomes 720 hours (30 days) for everyone.
--
-- The Security pane was hidden from tenants in 5.11.0, so no customer can set
-- this themselves: whatever the column holds IS the product behaviour. It was
-- 12 hours, which meant a working day ended with a login screen.
--
-- Raising it is only defensible together with the rest of 6.13.0:
--   * the refresh token now lives in an httpOnly, Secure, SameSite=Strict
--     cookie instead of localStorage, so JavaScript cannot read it and an XSS
--     no longer hands over a month-long session;
--   * every session has an ABSOLUTE 30-day cap enforced server-side, so a
--     session that is kept artificially alive still dies on schedule;
--   * destructive actions ask for the password again.
--
-- Existing rows are updated, not just the default, because a default only
-- applies to rows created after it.

ALTER TABLE "SecuritySettings" ALTER COLUMN "adminSessionTimeoutValue" SET DEFAULT 720;
ALTER TABLE "SecuritySettings" ALTER COLUMN "adminSessionTimeoutUnit" SET DEFAULT 'HOURS';

UPDATE "SecuritySettings"
SET "adminSessionTimeoutValue" = 720,
    "adminSessionTimeoutUnit"  = 'HOURS';
