-- 6.18.0 — the Security centre: access attempts + scan history.
--
-- AccessAttempt is intentionally NOT org-scoped and carries no RLS policy.
-- Every other table in this schema is walled off per organization, and that is
-- right for customer data. This table is different: a failed login has no
-- organization, because the credentials did not resolve to a user. Scoping it
-- would make the attacks that matter most — the ones that never got in —
-- belong to nobody, which is the same as not recording them. It is read only
-- by the founder area, which is guarded by requirePlatformAdmin.

CREATE TABLE IF NOT EXISTS "AccessAttempt" (
  "id"          TEXT PRIMARY KEY,
  "kind"        TEXT NOT NULL,
  "severity"    TEXT NOT NULL DEFAULT 'INFO',
  "ipAddress"   TEXT NOT NULL,
  "country"     TEXT,
  "countryName" TEXT,
  "city"        TEXT,
  "asn"         TEXT,
  "identifier"  TEXT,
  "client"      TEXT,
  "path"        TEXT,
  "succeeded"   BOOLEAN NOT NULL DEFAULT false,
  "details"     JSONB,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Every listing on the Security page is "recent first", usually filtered by one
-- of these columns. Without the composite indexes the page degrades from
-- instant to a sequential scan the moment the table has a few hundred thousand
-- rows, which one determined bot achieves in a weekend.
CREATE INDEX IF NOT EXISTS "AccessAttempt_createdAt_idx"            ON "AccessAttempt"("createdAt");
CREATE INDEX IF NOT EXISTS "AccessAttempt_ipAddress_createdAt_idx"  ON "AccessAttempt"("ipAddress", "createdAt");
CREATE INDEX IF NOT EXISTS "AccessAttempt_kind_createdAt_idx"       ON "AccessAttempt"("kind", "createdAt");
CREATE INDEX IF NOT EXISTS "AccessAttempt_country_createdAt_idx"    ON "AccessAttempt"("country", "createdAt");
CREATE INDEX IF NOT EXISTS "AccessAttempt_succeeded_createdAt_idx"  ON "AccessAttempt"("succeeded", "createdAt");

CREATE TABLE IF NOT EXISTS "SecurityScan" (
  "id"            TEXT PRIMARY KEY,
  "status"        TEXT NOT NULL DEFAULT 'RUNNING',
  "progress"      INTEGER NOT NULL DEFAULT 0,
  "currentStage"  TEXT,
  "passed"        INTEGER NOT NULL DEFAULT 0,
  "warnings"      INTEGER NOT NULL DEFAULT 0,
  "failures"      INTEGER NOT NULL DEFAULT 0,
  "score"         INTEGER,
  "startedById"   TEXT,
  "startedByName" TEXT,
  "startedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"    TIMESTAMP(3),
  "logJson"       TEXT
);
CREATE INDEX IF NOT EXISTS "SecurityScan_startedAt_idx" ON "SecurityScan"("startedAt");

CREATE TABLE IF NOT EXISTS "SecurityScanFinding" (
  "id"          TEXT PRIMARY KEY,
  "scanId"      TEXT NOT NULL REFERENCES "SecurityScan"("id") ON DELETE CASCADE,
  "stage"       TEXT NOT NULL,
  "checkId"     TEXT NOT NULL,
  "title"       TEXT NOT NULL,
  "status"      TEXT NOT NULL,
  "severity"    TEXT NOT NULL DEFAULT 'INFO',
  "detail"      TEXT,
  "remediation" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "SecurityScanFinding_scanId_stage_idx"  ON "SecurityScanFinding"("scanId", "stage");
CREATE INDEX IF NOT EXISTS "SecurityScanFinding_checkId_createdAt_idx" ON "SecurityScanFinding"("checkId", "createdAt");
