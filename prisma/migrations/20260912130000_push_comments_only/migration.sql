-- 7.8.3: push notifications are about comments, and nothing else.
--
-- Until now a push device carried a per-device list of company-wide events
-- (share opened, admin login, client comments, uploads, security alerts,
-- deadlines). The screen that edited that list had been hidden since 3.0.0,
-- so no device ever had its list chosen by a person: devices enrolled from
-- the entry bar (7.7.0) got nothing, devices enabled from Settings long ago
-- got everything. The product decision is now simple — every device gets
-- every client comment, plus the person's own bell notifications, and
-- nothing else — so every existing row is set to exactly that, and the
-- column default follows. Idempotent: rows already there are left alone.
UPDATE "PushSubscription"
SET "subscribedEvents" = ARRAY['CLIENT_COMMENT']::TEXT[]
WHERE "subscribedEvents" IS DISTINCT FROM ARRAY['CLIENT_COMMENT']::TEXT[];

ALTER TABLE "PushSubscription"
ALTER COLUMN "subscribedEvents" SET DEFAULT ARRAY['CLIENT_COMMENT']::TEXT[];
