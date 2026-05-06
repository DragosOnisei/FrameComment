-- AlterTable
-- Sub-second precision capture moment for click-to-seek; nullable for
-- backward compatibility with comments created before 1.0.3.
ALTER TABLE "Comment" ADD COLUMN     "timestampMs" INTEGER;
