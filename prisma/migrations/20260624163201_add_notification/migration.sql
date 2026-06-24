-- 3.5.0+: In-app "internal" notifications for the admin bell.
--
-- Backs the live bell in the admin top bar. When a reviewer clicks
-- "Send to editor" on a video, one row is created here for the
-- video's uploader (Video.createdById) and published on a Redis
-- channel so the editor's bell updates live (SSE) without a refresh.
--
-- Distinct from "NotificationQueue", which drives EXTERNAL email /
-- push delivery. This table is purely the in-app feed.
--
-- Dedupe rule (enforced in the API, not the schema): one UNREAD row
-- per (recipientId, videoId). Re-sending the same video before it's
-- read bumps the existing row to the top; different videos get their
-- own rows.

CREATE TABLE "Notification" (
  "id"          TEXT NOT NULL,
  "recipientId" TEXT NOT NULL,
  "type"        TEXT NOT NULL DEFAULT 'NEW_COMMENTS',
  "projectId"   TEXT NOT NULL,
  "videoId"     TEXT NOT NULL,
  "videoName"   TEXT NOT NULL,
  "folderId"    TEXT,
  "actorName"   TEXT,
  "isRead"      BOOLEAN NOT NULL DEFAULT false,
  "readAt"      TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Notification_recipientId_isRead_createdAt_idx"
  ON "Notification"("recipientId", "isRead", "createdAt");

CREATE INDEX "Notification_recipientId_videoId_idx"
  ON "Notification"("recipientId", "videoId");

ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_recipientId_fkey"
  FOREIGN KEY ("recipientId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_videoId_fkey"
  FOREIGN KEY ("videoId") REFERENCES "Video"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
