-- 7.18.0: two more kinds of media next to VIDEO and IMAGE.
--
-- AUDIO (mp3 / wav / m4a / aac) plays in the existing player over a static
-- artwork, with the timeline and timecoded comments of a video. DOCUMENT
-- (pdf / txt / docx) opens in an in-page viewer — zoom, pan, pages — and
-- carries no comments. Both skip the FFmpeg pipeline the way IMAGE does and
-- are READY the moment the upload lands.
--
-- Additive and idempotent: ADD VALUE IF NOT EXISTS leaves an enum that
-- already has the value alone. No row changes — existing rows keep VIDEO or
-- IMAGE, which is the truth about them.
ALTER TYPE "MediaType" ADD VALUE IF NOT EXISTS 'AUDIO';
ALTER TYPE "MediaType" ADD VALUE IF NOT EXISTS 'DOCUMENT';
