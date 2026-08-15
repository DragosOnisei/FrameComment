-- 6.11.0 — approval removed from the product.
--
-- The concept of an "approved" video no longer exists anywhere in the app.
-- Rather than dropping the columns (which would throw away the historical
-- `approvedAt` timestamps), every row is flipped to approved and the default
-- is inverted, so any code path that still reads the column — including an
-- older container during a rolling deploy — sees a consistent "yes".

ALTER TABLE "Video" ALTER COLUMN "approved" SET DEFAULT true;

UPDATE "Video" SET "approved" = true WHERE "approved" = false;

-- Projects parked in the (now unreachable) APPROVED status would otherwise be
-- stuck there forever: nothing sets that status any more, and the endpoints
-- that cleared it are gone.
UPDATE "Project" SET "status" = 'IN_REVIEW' WHERE "status" = 'APPROVED';
