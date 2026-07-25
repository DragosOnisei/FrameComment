-- 4.3.0: account roles + ownership-transfer safety net.
--
-- This migration ONLY extends the enum and creates the transfer table. It does
-- NOT use any of the new UserRole values — Postgres forbids using a value added
-- by ALTER TYPE ... ADD VALUE inside the same transaction. The data migration
-- that promotes the first user to OWNER lives in the next migration
-- (20260721130000_promote_first_owner), which runs in its own transaction.

-- Extend the role enum (idempotent). Requires Postgres 12+.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'OWNER';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'EDITOR';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'MARKETING';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'PRODUCER';

-- Ownership-transfer lifecycle enum.
DO $$ BEGIN
  CREATE TYPE "OwnershipTransferStatus" AS ENUM ('GRACE', 'FINALIZED', 'REVERSED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Ownership-transfer records (30-day grace / reversal window).
CREATE TABLE IF NOT EXISTS "OwnershipTransfer" (
  "id"             TEXT NOT NULL,
  "fromUserId"     TEXT NOT NULL,
  "toUserId"       TEXT NOT NULL,
  "toPreviousRole" "UserRole" NOT NULL,
  "status"         "OwnershipTransferStatus" NOT NULL DEFAULT 'GRACE',
  "initiatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "graceEndsAt"    TIMESTAMP(3) NOT NULL,
  "finalizedAt"    TIMESTAMP(3),
  "reversedAt"     TIMESTAMP(3),
  CONSTRAINT "OwnershipTransfer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OwnershipTransfer_status_idx" ON "OwnershipTransfer"("status");
CREATE INDEX IF NOT EXISTS "OwnershipTransfer_graceEndsAt_idx" ON "OwnershipTransfer"("graceEndsAt");

-- Hard backstop for the single-owner invariant: at most ONE transfer may sit in
-- the GRACE window at any time. The app also checks before inserting, but this
-- partial unique index makes a concurrent double-initiate impossible at the DB
-- level (the second INSERT fails, its transaction rolls back). (Not expressible
-- in the Prisma schema, so it lives here in raw SQL only.)
CREATE UNIQUE INDEX IF NOT EXISTS "OwnershipTransfer_one_active_grace"
  ON "OwnershipTransfer" ("status")
  WHERE "status" = 'GRACE';

ALTER TABLE "OwnershipTransfer"
  ADD CONSTRAINT "OwnershipTransfer_fromUserId_fkey"
  FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OwnershipTransfer"
  ADD CONSTRAINT "OwnershipTransfer_toUserId_fkey"
  FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
