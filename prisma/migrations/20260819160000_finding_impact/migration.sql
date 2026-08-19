-- 6.19.0 — a plain-language line on every finding.
--
-- `detail` says what was observed and `remediation` says what to type. Both
-- assume the reader already knows why the check exists. `impact` is the
-- sentence in between: what could actually go wrong, without jargon.
ALTER TABLE "SecurityScanFinding" ADD COLUMN IF NOT EXISTS "impact" TEXT;
