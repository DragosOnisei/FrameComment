-- 5.6 Multi-Tenant Phase 4: TeamInvite — invite links for team members.
--
-- New TENANT table, so it gets the full multi-tenant treatment in one shot:
--   * organizationId with the NULLIF(current_setting(...)) default (same as
--     the 32 core tables after 20260802130000) — an invite created inside an
--     armed request lands in the creating company automatically;
--   * FK -> Organization ON DELETE CASCADE;
--   * ENABLE + FORCE ROW LEVEL SECURITY + the org_isolation policy;
--   * explicit GRANT to framecomment_app (default privileges from
--     20260801130000 should already cover it; explicit = belt and braces).

CREATE TABLE "TeamInvite" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'EDITOR',
    "invitedById" TEXT,
    "invitedByName" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organizationId" TEXT DEFAULT NULLIF(current_setting('app.current_organization_id', true), ''),

    CONSTRAINT "TeamInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TeamInvite_tokenHash_key" ON "TeamInvite"("tokenHash");
CREATE INDEX "TeamInvite_organizationId_idx" ON "TeamInvite"("organizationId");

ALTER TABLE "TeamInvite" ADD CONSTRAINT "TeamInvite_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security: identical shape to the core tables.
ALTER TABLE "TeamInvite" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TeamInvite" FORCE ROW LEVEL SECURITY;

CREATE POLICY "org_isolation" ON "TeamInvite"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "TeamInvite" TO framecomment_app;
