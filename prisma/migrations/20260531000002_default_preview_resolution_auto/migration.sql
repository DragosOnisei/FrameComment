-- 1.9.4+ Phase A: swap the default `previewResolution` to "auto"
-- so new projects automatically match the source resolution
-- instead of being capped at a hard-coded tier. Existing projects
-- keep whatever they had selected — only the schema default flips.
ALTER TABLE "Project" ALTER COLUMN "previewResolution" SET DEFAULT 'auto';

-- Same flip on the global Settings table that supplies the "default"
-- new-project preset.
ALTER TABLE "Settings" ALTER COLUMN "defaultPreviewResolution" SET DEFAULT 'auto';
