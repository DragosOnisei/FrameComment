-- 2.4.2+: the schema default for the admin inactivity timeout
-- moved from `15 MINUTES` to `12 HOURS` to match the actual
-- admin UX (long edit + upload + review sessions across a single
-- workday). Prisma's `@default` only fires on row insert, so
-- existing installs still hold the legacy `15 MINUTES` value in
-- the SecuritySettings row even after the code upgrade — the
-- "Your session has expired" banner kept firing every quarter
-- hour despite the bump.
--
-- This migration nudges any row that's STILL on the legacy
-- implicit default forward to the new default. Admins who
-- deliberately picked a different value (any value other than
-- exactly `15 MINUTES`) are left untouched — their choice was
-- intentional and we shouldn't override it.
--
-- The hard cap at 24 HOURS in `SessionMonitor.tsx` is unchanged,
-- so the worst-case session still tops out at one day.
UPDATE "SecuritySettings"
   SET "adminSessionTimeoutValue" = 12,
       "adminSessionTimeoutUnit" = 'HOURS'
 WHERE "adminSessionTimeoutValue" = 15
   AND "adminSessionTimeoutUnit" = 'MINUTES';
