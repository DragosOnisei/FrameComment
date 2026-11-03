-- 7.20.0: the edits of a Meta ad, so a video's code is "FC2E1V1".
--
-- FC2 is the ad (the folder's Meta ID, migration `meta_id`); E1 is the edit
-- — the same for its 9:16, 4:5 and 1:1 exports, which share a name except
-- for the ratio — and V1 the version. Edit numbers are stored the first
-- time an edit is seen under its ad and never change afterwards, because
-- they are copied into Meta. Additive and idempotent.

CREATE TABLE IF NOT EXISTS "MetaEdit" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "editKey" TEXT NOT NULL,
    "editNumber" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MetaEdit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MetaEdit_folderId_editKey_key" ON "MetaEdit"("folderId", "editKey");
CREATE UNIQUE INDEX IF NOT EXISTS "MetaEdit_folderId_editNumber_key" ON "MetaEdit"("folderId", "editNumber");
CREATE INDEX IF NOT EXISTS "MetaEdit_organizationId_idx" ON "MetaEdit"("organizationId");

-- Tenant table: forced RLS with the standard policy, an explicit grant,
-- and cascade keys to Organization (org deletion) and to the ad folder.
ALTER TABLE "MetaEdit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MetaEdit" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'MetaEdit' AND policyname = 'org_isolation'
    ) THEN
        CREATE POLICY "org_isolation" ON "MetaEdit"
            USING ("organizationId" = current_setting('app.current_organization_id', true))
            WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MetaEdit_organizationId_fkey') THEN
        ALTER TABLE "MetaEdit" ADD CONSTRAINT "MetaEdit_organizationId_fkey"
            FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MetaEdit_folderId_fkey') THEN
        ALTER TABLE "MetaEdit" ADD CONSTRAINT "MetaEdit_folderId_fkey"
            FOREIGN KEY ("folderId") REFERENCES "Folder"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;
GRANT SELECT, INSERT, UPDATE, DELETE ON "MetaEdit" TO framecomment_app;
