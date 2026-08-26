-- 7.3.0 — in-app feedback with a founder inbox.
--
-- Additive and idempotent, per the project rule: every statement guards with
-- IF NOT EXISTS so a re-run on a database that already has the tables is a
-- no-op rather than a failed deploy.
--
-- These tables are PLATFORM-level, like "AccessAttempt": no organizationId
-- column, no row-level security policy, read only through the privileged role.
-- The sender's organisation is recorded as plain columns for context, not as a
-- tenancy boundary.

CREATE TABLE IF NOT EXISTS "Feedback" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "userId" TEXT,
    "userName" TEXT,
    "userEmail" TEXT,
    "organizationId" TEXT,
    "organizationName" TEXT,
    "appVersion" TEXT,
    "pageUrl" TEXT,
    "client" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FeedbackAttachment" (
    "id" TEXT NOT NULL,
    "feedbackId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "storageBackend" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeedbackAttachment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Feedback_status_createdAt_idx" ON "Feedback"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "Feedback_createdAt_idx" ON "Feedback"("createdAt");
CREATE INDEX IF NOT EXISTS "FeedbackAttachment_feedbackId_idx" ON "FeedbackAttachment"("feedbackId");

-- The foreign key is added separately so a re-run does not abort on a duplicate
-- constraint: Postgres has no IF NOT EXISTS for ADD CONSTRAINT.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'FeedbackAttachment_feedbackId_fkey'
    ) THEN
        ALTER TABLE "FeedbackAttachment"
            ADD CONSTRAINT "FeedbackAttachment_feedbackId_fkey"
            FOREIGN KEY ("feedbackId") REFERENCES "Feedback"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- Reading is the privileged role's job; the app role must not see other
-- organisations' feedback through a stray tenant query.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'framecomment_app') THEN
        REVOKE ALL ON TABLE "Feedback" FROM framecomment_app;
        REVOKE ALL ON TABLE "FeedbackAttachment" FROM framecomment_app;
    END IF;
END
$$;
