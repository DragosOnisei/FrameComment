-- 2.4.0+: Frame.io-style URL shortener.
--
-- Adds a tiny `ShortLink` table that maps an 8-character random
-- slug to a target URL (the long signed share URL we already
-- generate). A separate `fcmt.io` domain points its HTTP traffic
-- at the same FrameComment container, and a Next.js middleware
-- detects `Host: fcmt.io` to resolve the slug + 302 redirect to
-- targetUrl.
--
-- Also adds `Settings.shortLinkDomain` so the admin can configure
-- which domain to use (NULL = feature disabled, share modal falls
-- back to the long URL like pre-2.4.0).

ALTER TABLE "Settings"
  ADD COLUMN "shortLinkDomain" TEXT;

CREATE TABLE "ShortLink" (
  "id"        TEXT NOT NULL,
  "slug"      TEXT NOT NULL,
  "targetUrl" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ShortLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShortLink_slug_key" ON "ShortLink"("slug");
CREATE INDEX "ShortLink_slug_idx" ON "ShortLink"("slug");
CREATE INDEX "ShortLink_expiresAt_idx" ON "ShortLink"("expiresAt");
