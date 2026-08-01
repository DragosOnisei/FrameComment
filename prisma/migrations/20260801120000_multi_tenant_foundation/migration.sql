-- 5.0 Multi-Tenant Phase 1: foundation (see MULTI_TENANT_MIGRATION.md).
--
-- 1) Organization table (the tenant).
-- 2) Default organization 'org-1' — every existing row is backfilled into it,
--    named after the current Settings.companyName (the operator's company).
-- 3) organizationId on every tenant table, NULLABLE with DEFAULT 'org-1':
--    * existing rows are backfilled by the default (PG11+ fast path),
--    * legacy code paths that don't yet pass organizationId keep working —
--      new rows land in org-1, which is correct while org-1 is the only
--      tenant. Register stays closed until every create is explicit
--      (Phase 3), then a cleanup migration drops the defaults + sets NOT NULL.
-- 4) FK -> Organization ON DELETE CASCADE ("delete company" wipes its data),
--    plus an index per table (unique for the per-org singletons
--    Settings / SecuritySettings).

CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");
CREATE INDEX "Organization_status_idx" ON "Organization"("status");

-- The default organization. Name comes from the operator's configured company
-- name when present; falls back to 'My Company'.
INSERT INTO "Organization" ("id", "name", "slug", "status", "createdAt", "updatedAt")
VALUES (
    'org-1',
    COALESCE((SELECT NULLIF(TRIM("companyName"), '') FROM "Settings" WHERE "id" = 'default'), 'My Company'),
    'org-1',
    'ACTIVE',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);

-- User
ALTER TABLE "User" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "User" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "User_organizationId_idx" ON "User"("organizationId");

-- OwnershipTransfer
ALTER TABLE "OwnershipTransfer" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "OwnershipTransfer" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "OwnershipTransfer" ADD CONSTRAINT "OwnershipTransfer_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "OwnershipTransfer_organizationId_idx" ON "OwnershipTransfer"("organizationId");

-- Project
ALTER TABLE "Project" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "Project" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "Project" ADD CONSTRAINT "Project_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Project_organizationId_idx" ON "Project"("organizationId");

-- Folder
ALTER TABLE "Folder" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "Folder" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Folder_organizationId_idx" ON "Folder"("organizationId");

-- FolderDocument
ALTER TABLE "FolderDocument" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "FolderDocument" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "FolderDocument" ADD CONSTRAINT "FolderDocument_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "FolderDocument_organizationId_idx" ON "FolderDocument"("organizationId");

-- ProjectRecipient
ALTER TABLE "ProjectRecipient" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "ProjectRecipient" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "ProjectRecipient" ADD CONSTRAINT "ProjectRecipient_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "ProjectRecipient_organizationId_idx" ON "ProjectRecipient"("organizationId");

-- Video
ALTER TABLE "Video" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "Video" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "Video" ADD CONSTRAINT "Video_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Video_organizationId_idx" ON "Video"("organizationId");

-- VideoAsset
ALTER TABLE "VideoAsset" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "VideoAsset" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "VideoAsset_organizationId_idx" ON "VideoAsset"("organizationId");

-- ProjectUpload
ALTER TABLE "ProjectUpload" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "ProjectUpload" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "ProjectUpload" ADD CONSTRAINT "ProjectUpload_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "ProjectUpload_organizationId_idx" ON "ProjectUpload"("organizationId");

-- Comment
ALTER TABLE "Comment" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "Comment" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Comment_organizationId_idx" ON "Comment"("organizationId");

-- Marker
ALTER TABLE "Marker" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "Marker" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "Marker" ADD CONSTRAINT "Marker_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Marker_organizationId_idx" ON "Marker"("organizationId");

-- CommentReaction
ALTER TABLE "CommentReaction" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "CommentReaction" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "CommentReaction" ADD CONSTRAINT "CommentReaction_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "CommentReaction_organizationId_idx" ON "CommentReaction"("organizationId");

-- NotificationQueue
ALTER TABLE "NotificationQueue" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "NotificationQueue" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "NotificationQueue" ADD CONSTRAINT "NotificationQueue_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "NotificationQueue_organizationId_idx" ON "NotificationQueue"("organizationId");

-- Notification
ALTER TABLE "Notification" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "Notification" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Notification_organizationId_idx" ON "Notification"("organizationId");

-- Settings
ALTER TABLE "Settings" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "Settings" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "Settings" ADD CONSTRAINT "Settings_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Settings_organizationId_key" ON "Settings"("organizationId");

-- BillingSnapshot
ALTER TABLE "BillingSnapshot" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "BillingSnapshot" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "BillingSnapshot" ADD CONSTRAINT "BillingSnapshot_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "BillingSnapshot_organizationId_idx" ON "BillingSnapshot"("organizationId");

-- NotificationDestination
ALTER TABLE "NotificationDestination" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "NotificationDestination" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "NotificationDestination" ADD CONSTRAINT "NotificationDestination_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "NotificationDestination_organizationId_idx" ON "NotificationDestination"("organizationId");

-- NotificationSubscription
ALTER TABLE "NotificationSubscription" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "NotificationSubscription" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "NotificationSubscription" ADD CONSTRAINT "NotificationSubscription_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "NotificationSubscription_organizationId_idx" ON "NotificationSubscription"("organizationId");

-- NotificationDeliveryLog
ALTER TABLE "NotificationDeliveryLog" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "NotificationDeliveryLog" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "NotificationDeliveryLog" ADD CONSTRAINT "NotificationDeliveryLog_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "NotificationDeliveryLog_organizationId_idx" ON "NotificationDeliveryLog"("organizationId");

-- SecuritySettings
ALTER TABLE "SecuritySettings" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "SecuritySettings" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "SecuritySettings" ADD CONSTRAINT "SecuritySettings_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "SecuritySettings_organizationId_key" ON "SecuritySettings"("organizationId");

-- SecurityEvent
ALTER TABLE "SecurityEvent" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "SecurityEvent" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "SecurityEvent_organizationId_idx" ON "SecurityEvent"("organizationId");

-- BlockedIP
ALTER TABLE "BlockedIP" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "BlockedIP" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "BlockedIP" ADD CONSTRAINT "BlockedIP_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "BlockedIP_organizationId_idx" ON "BlockedIP"("organizationId");

-- BlockedDomain
ALTER TABLE "BlockedDomain" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "BlockedDomain" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "BlockedDomain" ADD CONSTRAINT "BlockedDomain_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "BlockedDomain_organizationId_idx" ON "BlockedDomain"("organizationId");

-- VideoAnalytics
ALTER TABLE "VideoAnalytics" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "VideoAnalytics" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "VideoAnalytics" ADD CONSTRAINT "VideoAnalytics_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "VideoAnalytics_organizationId_idx" ON "VideoAnalytics"("organizationId");

-- SharePageAccess
ALTER TABLE "SharePageAccess" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "SharePageAccess" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "SharePageAccess" ADD CONSTRAINT "SharePageAccess_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "SharePageAccess_organizationId_idx" ON "SharePageAccess"("organizationId");

-- PasskeyCredential
ALTER TABLE "PasskeyCredential" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "PasskeyCredential" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "PasskeyCredential" ADD CONSTRAINT "PasskeyCredential_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "PasskeyCredential_organizationId_idx" ON "PasskeyCredential"("organizationId");

-- PushSubscription
ALTER TABLE "PushSubscription" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "PushSubscription" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "PushSubscription_organizationId_idx" ON "PushSubscription"("organizationId");

-- EmailTemplate
ALTER TABLE "EmailTemplate" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "EmailTemplate" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "EmailTemplate" ADD CONSTRAINT "EmailTemplate_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "EmailTemplate_organizationId_idx" ON "EmailTemplate"("organizationId");

-- ClientCompany
ALTER TABLE "ClientCompany" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "ClientCompany" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "ClientCompany" ADD CONSTRAINT "ClientCompany_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "ClientCompany_organizationId_idx" ON "ClientCompany"("organizationId");

-- CalendarToken
ALTER TABLE "CalendarToken" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "CalendarToken" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "CalendarToken" ADD CONSTRAINT "CalendarToken_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "CalendarToken_organizationId_idx" ON "CalendarToken"("organizationId");

-- ShortLink
ALTER TABLE "ShortLink" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "ShortLink" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "ShortLink" ADD CONSTRAINT "ShortLink_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "ShortLink_organizationId_idx" ON "ShortLink"("organizationId");

-- ClientContact
ALTER TABLE "ClientContact" ADD COLUMN "organizationId" TEXT DEFAULT 'org-1';
UPDATE "ClientContact" SET "organizationId" = 'org-1' WHERE "organizationId" IS NULL;
ALTER TABLE "ClientContact" ADD CONSTRAINT "ClientContact_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "ClientContact_organizationId_idx" ON "ClientContact"("organizationId");
