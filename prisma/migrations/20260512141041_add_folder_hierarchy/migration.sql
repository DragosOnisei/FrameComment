-- v1.0.6: Frame.io-style folders inside projects.
-- Folders form a self-referencing tree per project; each folder has
-- its own share slug + auth so it can be shared independently from
-- the parent project.

-- CreateTable
CREATE TABLE "Folder" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "parentFolderId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "sharePassword" TEXT,
    "authMode" TEXT NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "Folder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Folder_slug_key" ON "Folder"("slug");

-- CreateIndex
CREATE INDEX "Folder_projectId_idx" ON "Folder"("projectId");

-- CreateIndex
CREATE INDEX "Folder_parentFolderId_idx" ON "Folder"("parentFolderId");

-- AddForeignKey
ALTER TABLE "Folder"
    ADD CONSTRAINT "Folder_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (self-reference for tree)
ALTER TABLE "Folder"
    ADD CONSTRAINT "Folder_parentFolderId_fkey"
    FOREIGN KEY ("parentFolderId") REFERENCES "Folder"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Folder"
    ADD CONSTRAINT "Folder_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: Video.folderId — nullable so existing rows stay at
-- project root (folderId = NULL). Set NULL on folder delete so we
-- never lose the video even if its parent folder is removed.
ALTER TABLE "Video" ADD COLUMN "folderId" TEXT;

-- CreateIndex
CREATE INDEX "Video_folderId_idx" ON "Video"("folderId");

-- AddForeignKey
ALTER TABLE "Video"
    ADD CONSTRAINT "Video_folderId_fkey"
    FOREIGN KEY ("folderId") REFERENCES "Folder"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
