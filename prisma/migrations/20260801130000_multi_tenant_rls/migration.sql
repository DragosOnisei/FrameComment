-- 5.0 Multi-Tenant Phase 1: Row-Level Security (see MULTI_TENANT_MIGRATION.md).
--
-- Defense in depth: even if an app query ever forgets an organizationId
-- filter, Postgres itself refuses to return (or accept) rows belonging to a
-- different organization.
--
-- HOW IT ARMS (staged, zero behavioral change today):
--   * Policies compare organizationId with current_setting('app.current_organization_id').
--     The app sets that per request (Phase 2 wires it through auth).
--   * RLS does NOT apply to superusers. The app currently connects as the
--     Postgres superuser, so these policies are dormant until the operator
--     flips the app/worker to the non-superuser role created below
--     (documented one-time step: set a password + change DATABASE_URL).
--   * FORCE ROW LEVEL SECURITY makes policies apply even to the table OWNER,
--     so a future non-superuser owner can't accidentally bypass them.
--   * current_setting(..., true) returns NULL when unset -> the comparison is
--     NULL -> DENY BY DEFAULT. A connection without org context sees nothing.
--
-- The dedicated application role. NOLOGIN on purpose: no password ships in a
-- migration. The operator enables it when flipping:
--   ALTER ROLE framecomment_app LOGIN PASSWORD '<strong password>';
--   -- then point the app's DATABASE_URL at framecomment_app
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'framecomment_app') THEN
        CREATE ROLE framecomment_app NOLOGIN;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA "public" TO framecomment_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO framecomment_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "public" TO framecomment_app;
-- Future tables created by the migration user inherit the grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO framecomment_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
    GRANT USAGE, SELECT ON SEQUENCES TO framecomment_app;

-- The Organization table itself: a tenant can only see its own row. The
-- register flow pre-generates the new org id and sets the context before
-- inserting, so WITH CHECK passes for legitimate self-creation.
ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Organization" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "Organization"
    USING ("id" = current_setting('app.current_organization_id', true))
    WITH CHECK ("id" = current_setting('app.current_organization_id', true));

ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "User"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "OwnershipTransfer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OwnershipTransfer" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "OwnershipTransfer"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "Project" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Project" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "Project"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "Folder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Folder" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "Folder"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "FolderDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FolderDocument" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "FolderDocument"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "ProjectRecipient" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProjectRecipient" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "ProjectRecipient"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "Video" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Video" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "Video"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "VideoAsset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VideoAsset" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "VideoAsset"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "ProjectUpload" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProjectUpload" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "ProjectUpload"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "Comment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Comment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "Comment"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "Marker" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Marker" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "Marker"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "CommentReaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CommentReaction" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "CommentReaction"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "NotificationQueue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationQueue" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "NotificationQueue"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "Notification"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "Settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "Settings"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "BillingSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingSnapshot" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "BillingSnapshot"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "NotificationDestination" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationDestination" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "NotificationDestination"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "NotificationSubscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationSubscription" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "NotificationSubscription"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "NotificationDeliveryLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationDeliveryLog" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "NotificationDeliveryLog"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "SecuritySettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SecuritySettings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "SecuritySettings"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "SecurityEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SecurityEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "SecurityEvent"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "BlockedIP" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BlockedIP" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "BlockedIP"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "BlockedDomain" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BlockedDomain" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "BlockedDomain"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "VideoAnalytics" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VideoAnalytics" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "VideoAnalytics"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "SharePageAccess" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SharePageAccess" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "SharePageAccess"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "PasskeyCredential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PasskeyCredential" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "PasskeyCredential"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "PushSubscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PushSubscription" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "PushSubscription"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "EmailTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailTemplate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "EmailTemplate"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "ClientCompany" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientCompany" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "ClientCompany"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "CalendarToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CalendarToken" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "CalendarToken"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "ShortLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShortLink" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "ShortLink"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

ALTER TABLE "ClientContact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientContact" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "ClientContact"
    USING ("organizationId" = current_setting('app.current_organization_id', true))
    WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));
