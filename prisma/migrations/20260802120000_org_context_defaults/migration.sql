-- 5.0 Multi-Tenant Phase 3d: org-aware column defaults.
--
-- Phase 1 shipped organizationId with a STATIC default of 'org-1' so legacy
-- code kept working while org-1 was the only tenant. Now that:
--   * every authenticated/share/content request arms the org context, and
--   * every model operation runs inside a [set_config, op] transaction
--     (db.ts extension), and
--   * interactive transactions + worker/boot creates set the org explicitly,
-- the default flips to the SESSION SETTING: a create without an explicit
-- organizationId lands in the REQUESTING company automatically.
--
-- Fail-safe direction: with NO context armed, current_setting(..., true)
-- returns NULL -> the row gets a NULL organizationId, which RLS hides from
-- every tenant (post-flip). A misconfigured path yields an invisible row —
-- never a row leaked into another company.

ALTER TABLE "User" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "OwnershipTransfer" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "Project" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "Folder" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "FolderDocument" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "ProjectRecipient" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "Video" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "VideoAsset" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "ProjectUpload" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "Comment" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "Marker" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "CommentReaction" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "NotificationQueue" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "Notification" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "Settings" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "BillingSnapshot" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "NotificationDestination" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "NotificationSubscription" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "NotificationDeliveryLog" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "SecuritySettings" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "SecurityEvent" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "BlockedIP" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "BlockedDomain" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "VideoAnalytics" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "SharePageAccess" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "PasskeyCredential" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "PushSubscription" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "EmailTemplate" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "ClientCompany" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "CalendarToken" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "ShortLink" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
ALTER TABLE "ClientContact" ALTER COLUMN "organizationId"
    SET DEFAULT current_setting('app.current_organization_id', true);
