-- 5.14: landing-page early-access requests + single-use registration links.
--
-- 1) Notification grows beyond video feedback: EARLY_ACCESS rows carry a
--    free-text `message` and no project/video, so those columns loosen to
--    NULLable (the FKs already tolerate NULL).
ALTER TABLE "Notification" ALTER COLUMN "projectId" DROP NOT NULL;
ALTER TABLE "Notification" ALTER COLUMN "videoId" DROP NOT NULL;
ALTER TABLE "Notification" ALTER COLUMN "videoName" DROP NOT NULL;
ALTER TABLE "Notification" ADD COLUMN "message" TEXT;

-- 2) RegistrationInvite: platform-level single-use "access link" codes for
--    inviting a new company to register. No organizationId on purpose —
--    created by the platform Owner, consumed by the public register flow.
--    (Post-flip grants: covered by the ALTER DEFAULT PRIVILEGES set up in
--    20260801130000_multi_tenant_rls.)
CREATE TABLE "RegistrationInvite" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedByOrgId" TEXT,
    "usedByEmail" TEXT,

    CONSTRAINT "RegistrationInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RegistrationInvite_code_key" ON "RegistrationInvite"("code");
CREATE INDEX "RegistrationInvite_expiresAt_idx" ON "RegistrationInvite"("expiresAt");
