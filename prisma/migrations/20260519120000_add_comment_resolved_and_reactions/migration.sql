-- 1.2.0: Frame.io-style "Mark as done" workflow + emoji reactions on
-- comments. Adds three new columns on Comment (resolved bookkeeping)
-- and a new CommentReaction table with a unique constraint on
-- (commentId, sessionId, emoji) so toggling is idempotent.

ALTER TABLE "Comment"
ADD COLUMN "isResolved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "resolvedAt" TIMESTAMP(3),
ADD COLUMN "resolvedBy" TEXT;

CREATE INDEX "Comment_isResolved_idx" ON "Comment"("isResolved");

CREATE TABLE "CommentReaction" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "authorName" TEXT,
    "sessionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommentReaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommentReaction_commentId_sessionId_emoji_key"
    ON "CommentReaction"("commentId", "sessionId", "emoji");

CREATE INDEX "CommentReaction_commentId_idx" ON "CommentReaction"("commentId");
CREATE INDEX "CommentReaction_sessionId_idx" ON "CommentReaction"("sessionId");

ALTER TABLE "CommentReaction"
    ADD CONSTRAINT "CommentReaction_commentId_fkey"
    FOREIGN KEY ("commentId") REFERENCES "Comment"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
