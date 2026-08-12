-- 6.7.0 — Founder AI Agents (Faza 4): Agent, AgentRun, AgentReport.
--
-- Platform-level, exactly like the CRM tables from 20260812120000: no
-- organizationId, so no org_isolation policy would apply, and the tenant role
-- is explicitly REVOKEd rather than inheriting CRUD from the ALTER DEFAULT
-- PRIVILEGES in 20260801130000_multi_tenant_rls. Only the privileged
-- connection, behind requirePlatformAdmin, touches these.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AgentType') THEN
        CREATE TYPE "AgentType" AS ENUM ('WEEKLY_DIGEST', 'PIPELINE_REVIEW', 'CHURN_WATCH');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AgentRunStatus') THEN
        CREATE TYPE "AgentRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "Agent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AgentType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "cadence" TEXT NOT NULL DEFAULT 'manual',
    "configJson" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AgentRun" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "error" TEXT,
    "model" TEXT,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "costCents" INTEGER,
    "triggeredBy" TEXT,
    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AgentRun_agentId_startedAt_idx" ON "AgentRun"("agentId", "startedAt");

CREATE TABLE IF NOT EXISTS "AgentReport" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "markdown" TEXT NOT NULL,
    "hasNarrative" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentReport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AgentReport_runId_key" ON "AgentReport"("runId");
CREATE INDEX IF NOT EXISTS "AgentReport_createdAt_idx" ON "AgentReport"("createdAt");

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AgentRun_agentId_fkey') THEN
        ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_agentId_fkey"
            FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AgentReport_runId_fkey') THEN
        ALTER TABLE "AgentReport" ADD CONSTRAINT "AgentReport_runId_fkey"
            FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- Seed the three agents that ship with the app, if they aren't there yet.
INSERT INTO "Agent" ("id", "name", "type", "cadence", "createdAt", "updatedAt")
SELECT 'agent_weekly_digest', 'Weekly digest', 'WEEKLY_DIGEST', 'manual', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Agent" WHERE "type" = 'WEEKLY_DIGEST');

INSERT INTO "Agent" ("id", "name", "type", "cadence", "createdAt", "updatedAt")
SELECT 'agent_pipeline_review', 'Pipeline review', 'PIPELINE_REVIEW', 'manual', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Agent" WHERE "type" = 'PIPELINE_REVIEW');

INSERT INTO "Agent" ("id", "name", "type", "cadence", "createdAt", "updatedAt")
SELECT 'agent_churn_watch', 'Churn watch', 'CHURN_WATCH', 'manual', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Agent" WHERE "type" = 'CHURN_WATCH');

-- The tenant role gets nothing here. See the header.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'framecomment_app') THEN
        REVOKE ALL ON "Agent" FROM framecomment_app;
        REVOKE ALL ON "AgentRun" FROM framecomment_app;
        REVOKE ALL ON "AgentReport" FROM framecomment_app;
    END IF;
END
$$;
