-- 7.21.0: the Trash is personal.
--
-- Until now every company had one shared Trash: whatever anyone deleted,
-- everyone saw. Each trashed row now records who deleted it; a person sees
-- their own deletions, Owner and Admin can also see the whole team's, and
-- deleting a user account purges that user's Trash so nothing is left
-- behind with no owner.
--
-- Additive and idempotent. Rows already in the Trash were deleted before
-- anyone recorded who did it, so they stay NULL — the truth — and stay
-- visible to everyone, as they always were, until they expire.
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "deletedById" TEXT;
ALTER TABLE "Folder" ADD COLUMN IF NOT EXISTS "deletedById" TEXT;
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "deletedById" TEXT;
ALTER TABLE "FolderDocument" ADD COLUMN IF NOT EXISTS "deletedById" TEXT;
