-- 6.8.0 — Founder investor pack (Faza 5):
-- PlatformAuditEvent, PlatformReportArchive, ServiceHeartbeat, ServiceOutage.
--
-- Platform-level like the CRM (20260812120000) and agent (20260812140000)
-- tables: no organizationId, so no org_isolation policy applies, and the
-- tenant role is REVOKEd rather than inheriting CRUD from the ALTER DEFAULT
-- PRIVILEGES in 20260801130000_multi_tenant_rls.
--
-- Note on the audit table specifically: SecurityEvent was NOT reused. It is
-- org-scoped, carries no actor, and is silenced by a per-tenant setting
-- (trackSecurityLogs). An audit trail a tenant can switch off is not one.

CREATE TABLE IF NOT EXISTS "PlatformAuditEvent" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "summary" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PlatformAuditEvent_createdAt_idx" ON "PlatformAuditEvent"("createdAt");
CREATE INDEX IF NOT EXISTS "PlatformAuditEvent_action_createdAt_idx" ON "PlatformAuditEvent"("action", "createdAt");

CREATE TABLE IF NOT EXISTS "PlatformReportArchive" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "metricsJson" TEXT NOT NULL,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformReportArchive_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PlatformReportArchive_periodTo_idx" ON "PlatformReportArchive"("periodTo");

CREATE TABLE IF NOT EXISTS "ServiceHeartbeat" (
    "service" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "bootedAt" TIMESTAMP(3) NOT NULL,
    "bootCount" INTEGER NOT NULL DEFAULT 1,
    "version" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ServiceHeartbeat_pkey" PRIMARY KEY ("service")
);

CREATE TABLE IF NOT EXISTS "ServiceOutage" (
    "id" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "seconds" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'gap',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ServiceOutage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ServiceOutage_service_startedAt_idx" ON "ServiceOutage"("service", "startedAt");

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'framecomment_app') THEN
        REVOKE ALL ON "PlatformAuditEvent" FROM framecomment_app;
        REVOKE ALL ON "PlatformReportArchive" FROM framecomment_app;
        REVOKE ALL ON "ServiceHeartbeat" FROM framecomment_app;
        REVOKE ALL ON "ServiceOutage" FROM framecomment_app;
    END IF;
END
$$;
