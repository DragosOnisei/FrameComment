-- 3.8.x: mark comments that were pasted in from another version, so the
-- thread can show a "Copied" tag (Frame.io-style) distinguishing
-- carried-over notes from fresh ones.
ALTER TABLE "Comment" ADD COLUMN "isCopied" BOOLEAN NOT NULL DEFAULT false;
