-- 3.9.x: "Create Transcript" feature.
--   1. OpenAI API key stored on Settings (server-side only).
--   2. New FolderDocument table so a folder can hold non-video files
--      (the timecoded transcript PDF the worker produces).

ALTER TABLE "Settings" ADD COLUMN "openaiApiKey" TEXT;

CREATE TABLE "FolderDocument" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "folderId" TEXT,
    "name" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/pdf',
    "size" BIGINT NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL DEFAULT 'transcript',
    "sourceVideoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "FolderDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FolderDocument_projectId_idx" ON "FolderDocument"("projectId");
CREATE INDEX "FolderDocument_folderId_idx" ON "FolderDocument"("folderId");
CREATE INDEX "FolderDocument_sourceVideoId_idx" ON "FolderDocument"("sourceVideoId");

ALTER TABLE "FolderDocument" ADD CONSTRAINT "FolderDocument_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FolderDocument" ADD CONSTRAINT "FolderDocument_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FolderDocument" ADD CONSTRAINT "FolderDocument_sourceVideoId_fkey" FOREIGN KEY ("sourceVideoId") REFERENCES "Video"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FolderDocument" ADD CONSTRAINT "FolderDocument_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
