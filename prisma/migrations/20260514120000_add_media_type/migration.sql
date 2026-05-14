-- 1.0.9: image support. Adds a MediaType enum + a mediaType column on Video.
-- Default VIDEO keeps every existing row unchanged.

CREATE TYPE "MediaType" AS ENUM ('VIDEO', 'IMAGE');

ALTER TABLE "Video"
ADD COLUMN "mediaType" "MediaType" NOT NULL DEFAULT 'VIDEO';
