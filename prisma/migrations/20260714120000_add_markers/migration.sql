-- 4.1.0: Premiere-style timeline markers. A coloured flag
-- (red/orange/green/blue) pinned to a video version at a millisecond
-- position, with an optional note + author. Separate from comment pins;
-- these are lightweight navigation bookmarks (jump with the up/down
-- arrows). Version-scoped via videoId so a marker dies with its version.

CREATE TABLE "Marker" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "videoVersion" INTEGER,
    "timestampMs" INTEGER NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'blue',
    "label" TEXT,
    "authorName" TEXT,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "userId" TEXT,
    "editorSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Marker_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Marker_projectId_idx" ON "Marker"("projectId");
CREATE INDEX "Marker_videoId_idx" ON "Marker"("videoId");
CREATE INDEX "Marker_userId_idx" ON "Marker"("userId");

ALTER TABLE "Marker"
    ADD CONSTRAINT "Marker_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Marker"
    ADD CONSTRAINT "Marker_videoId_fkey"
    FOREIGN KEY ("videoId") REFERENCES "Video"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Marker"
    ADD CONSTRAINT "Marker_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
