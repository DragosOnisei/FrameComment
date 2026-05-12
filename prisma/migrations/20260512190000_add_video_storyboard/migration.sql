-- Storyboard sprite-sheet for hover-scrub on the Frame.io-style
-- VideoCard. One JPEG packing 100 evenly-spaced frames in a 10×10
-- grid. Optional + nullable so legacy rows still load before the
-- worker has had a chance to backfill them.
ALTER TABLE "Video" ADD COLUMN "storyboardPath" TEXT;
