-- 5.4 Multi-Tenant Phase 3d fix: NULLIF-wrap the org column defaults.
--
-- Postgres quirk: once ANY transaction on a pooled connection has run
-- set_config('app.current_organization_id', ..., true), the parameter exists
-- at session level afterwards with value '' (EMPTY STRING) — current_setting
-- with missing_ok then returns '' instead of NULL outside armed transactions.
-- A create running WITHOUT an armed context on such a connection therefore
-- got DEFAULT '' -> FK violation on Organization (seen live in dev: video
-- upload failing with Video_organizationId_fkey).
--
-- NULLIF(..., '') restores the fail-safe design: no armed context -> NULL ->
-- valid (FKs ignore NULL) but invisible to every tenant post-flip. Never an
-- error, never a leak.

ALTER TABLE "User" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "OwnershipTransfer" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "Project" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "Folder" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "FolderDocument" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "ProjectRecipient" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "Video" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "VideoAsset" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "ProjectUpload" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "Comment" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "Marker" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "CommentReaction" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "NotificationQueue" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "Notification" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "Settings" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "BillingSnapshot" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "NotificationDestination" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "NotificationSubscription" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "NotificationDeliveryLog" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "SecuritySettings" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "SecurityEvent" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "BlockedIP" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "BlockedDomain" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "VideoAnalytics" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "SharePageAccess" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "PasskeyCredential" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "PushSubscription" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "EmailTemplate" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "ClientCompany" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "CalendarToken" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "ShortLink" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
ALTER TABLE "ClientContact" ALTER COLUMN "organizationId"
    SET DEFAULT NULLIF(current_setting('app.current_organization_id', true), '');
