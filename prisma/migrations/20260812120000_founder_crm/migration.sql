-- 6.6.0 — Founder CRM (Faza 3): Lead, LeadActivity, FollowUp.
--
-- PLATFORM-LEVEL tables, like RegistrationInvite: no organizationId, so no
-- org_isolation policy would mean anything here. These rows describe people
-- who want to become customers — the platform's own business, never a
-- tenant's data.
--
-- Because there is no policy to protect them, we go one step further than
-- RegistrationInvite did and REVOKE the tenant role's access outright. The
-- ALTER DEFAULT PRIVILEGES set up in 20260801130000_multi_tenant_rls would
-- otherwise hand framecomment_app full CRUD on every new table. Only the
-- privileged connection (DATABASE_URL_PRIVILEGED), used exclusively behind
-- requirePlatformAdmin, can read or write these.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LeadStatus') THEN
        CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'TRIAL', 'CUSTOMER', 'LOST');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LeadActivityType') THEN
        CREATE TYPE "LeadActivityType" AS ENUM ('NOTE', 'CALL', 'EMAIL', 'DEMO', 'STATUS_CHANGE');
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "Lead" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "company" TEXT,
    "profession" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "estimatedValueCents" INTEGER,
    "notes" TEXT,
    "convertedOrgId" TEXT,
    "convertedAt" TIMESTAMP(3),
    "registrationInviteId" TEXT,
    "lastContactedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Lead_email_key" ON "Lead"("email");
CREATE INDEX IF NOT EXISTS "Lead_status_idx" ON "Lead"("status");
CREATE INDEX IF NOT EXISTS "Lead_createdAt_idx" ON "Lead"("createdAt");

CREATE TABLE IF NOT EXISTS "LeadActivity" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "type" "LeadActivityType" NOT NULL DEFAULT 'NOTE',
    "body" TEXT,
    "authorId" TEXT,
    "authorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeadActivity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "LeadActivity_leadId_createdAt_idx" ON "LeadActivity"("leadId", "createdAt");

CREATE TABLE IF NOT EXISTS "FollowUp" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "doneAt" TIMESTAMP(3),
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FollowUp_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FollowUp_dueAt_idx" ON "FollowUp"("dueAt");
CREATE INDEX IF NOT EXISTS "FollowUp_leadId_idx" ON "FollowUp"("leadId");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'LeadActivity_leadId_fkey'
    ) THEN
        ALTER TABLE "LeadActivity" ADD CONSTRAINT "LeadActivity_leadId_fkey"
            FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'FollowUp_leadId_fkey'
    ) THEN
        ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_leadId_fkey"
            FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- The tenant role gets nothing here. See the header for why.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'framecomment_app') THEN
        REVOKE ALL ON "Lead" FROM framecomment_app;
        REVOKE ALL ON "LeadActivity" FROM framecomment_app;
        REVOKE ALL ON "FollowUp" FROM framecomment_app;
    END IF;
END
$$;
