-- 6.2.0 Founder area, Phase 0 — a dedicated PLATFORM organization.
--
-- Until now "the platform" was hardcoded to 'org-1', which is also the
-- founder's own marketing company (CPC MARKETING). That made it impossible for
-- that company to be treated as an ordinary paying customer, and it tied the
-- founder's identity to a client relationship that may end one day.
--
-- This migration introduces `Organization.isPlatform` and creates one platform
-- organization. Existing organizations, 'org-1' included, stay ordinary
-- tenants: they keep every row, setting and file they have today.

ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "isPlatform" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "Organization_isPlatform_idx" ON "Organization"("isPlatform");

-- The platform org uses a FIXED id so server code can compare against it
-- without a query (see `platformOrgId()` in src/lib/platform.ts).
INSERT INTO "Organization" ("id", "name", "slug", "status", "isPlatform", "createdAt", "updatedAt")
VALUES ('org-platform', 'FrameComment', 'framecomment-platform', 'ACTIVE', true, NOW(), NOW())
ON CONFLICT ("id") DO UPDATE SET "isPlatform" = true;

-- Exactly one platform org: if this ever runs on a database where another row
-- was flagged by hand, demote it.
UPDATE "Organization" SET "isPlatform" = false WHERE "id" <> 'org-platform' AND "isPlatform" = true;
