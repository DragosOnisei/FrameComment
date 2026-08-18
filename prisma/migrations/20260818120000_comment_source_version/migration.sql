-- 6.16.0 — remember WHICH version a carried-over comment was written on.
--
-- `isCopied` (3.8.x) records THAT a comment was pasted, not where from. When
-- you are looking at v3 and deciding whether a note still applies, "copied"
-- is not enough — you need "written on v1".
--
-- Both columns are nullable with no default and no backfill: comments pasted
-- before this migration genuinely have no recorded source, and inventing one
-- would be worse than admitting we do not know. They keep their plain
-- "Copied" tag; only new pastes carry the version.
ALTER TABLE "Comment"
  ADD COLUMN IF NOT EXISTS "sourceVideoId" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceVersionLabel" TEXT;

-- No foreign key on sourceVideoId, deliberately. A cascade delete of the old
-- version must not take the provenance of the comments carried into the new
-- one with it — the label is the part that has to survive, and it is stored
-- alongside precisely so it can.
