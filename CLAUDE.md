# CLAUDE.md — read this before touching anything

FrameComment: self-hosted, multi-tenant video review SaaS (Frame.io-style).
Company: MINDQUB S.R.L. Production: https://framecomment.com — Docker images on
Docker Hub (`dragosonisei/framecomment`), deployed on the founder's TrueNAS box.
The founder (Dragos) is the only developer-adjacent person; he tests on live,
writes in Romanian, and expects plain-language explanations of anything risky.

This file exists because the codebase has cross-cutting invariants that are not
visible from the file you happen to be editing. Every hard-won rule below was
paid for with a production bug. Do not trust this file over the code — when they
disagree, the code is newer; fix this file in the same commit.

## Stack

Next.js 16 (App Router for new work, a few Pages Router leftovers), React 19,
TypeScript strict, Prisma 6.19 on PostgreSQL 18 with **row-level security**,
Redis (queues + pub/sub), a long-running worker (`src/worker`, tsx), pdfkit for
PDFs, maxmind for local GeoIP. UI text lives in `src/locales/en.json` (single
locale, next-intl). Dark theme only.

## THE trap: RLS and raw SQL

Multi-tenant isolation is PostgreSQL RLS. The `prisma` client (src/lib/db.ts)
arms `app.current_organization_id` per request via AsyncLocalStorage + a
`$extends` that intercepts **model operations only**.

- `prisma.$queryRaw*` / `$executeRaw*` are **NOT armed**. On production the app
  connects as `framecomment_app` (not a superuser), so an unarmed raw statement
  matches **zero rows silently** — no error, SELECT returns [], UPDATE reports
  success having changed nothing. This one mechanism silently broke
  notifications, comment provenance, role edits, storage re-tagging and the
  ownership grace sweep (all fixed in 6.21.0).
- **Every raw statement on a request path must go through `rawArmed()`**
  (src/lib/db.ts) or use the typed delegates, which are armed.
- Array-form `$transaction([...])` is armed by a proxy (5.10.3). Interactive
  transactions must call `setOrgContextOn(tx, currentOrgId())` first.
- `prismaPrivileged` bypasses RLS. Legitimate uses: auth resolution, share-token
  resolution, worker, founder/platform pages, boot. Never in tenant routes.
- The worker runs on the privileged role on purpose (compose line ~131).
- A dev database running as superuser does not enforce RLS, so **these bugs are
  invisible locally and real on production**. That asymmetry has bitten twice.

## Verifying changes in the Claude sandbox

- `prisma generate` fails here (403 on binaries.prisma.sh), so local tsc checks
  against a **stale generated client**. After schema changes: patch the new
  fields into `node_modules/.prisma/client/index.d.ts` (back it up first), run
  tsc, restore the backup. CI regenerates the client fresh — code that passes
  locally can fail CI if it uses new columns through typed delegates; `as any`
  on the data object plus this patching technique is the established pattern.
- Typecheck: `NODE_OPTIONS=--max-old-space-size=2560 npx tsc --noEmit
  --incremental` (one bash call; it is slow). Then eslint on touched files only.
  Two pre-existing warnings in CommentSection/VideoPlayer are known noise.
- PDF report regression test: `npm run verify:report` (asserts every page
  carries a footer — the property that actually broke, twice).
- There is no test suite beyond that. Verification is tsc + eslint + a written
  list of manual test steps for Dragos.

## Releases — the rules Dragos actually enforces

- One version per batch of work. Do **not** create a tag per small fix; amend
  the unpushed commit instead. He was burned by 4 tags racing (`concurrency`
  now queues them, but the rule stands).
- Never commit until he says so (usually "hai cu comit").
- Tag `v<X.Y.Z>` must equal `package.json` version AND the `VERSION` file; the
  CHANGELOG must contain `## [X.Y.Z]` — CI extracts it as release notes and
  fails otherwise. Bump all three together.
- Give him push commands as copy-paste blocks starting with
  `cd ~/Downloads/FrameComment`, and **only the latest tag**:
  `git push origin main` then `git push origin v<latest>`.
- Version numbers that were tagged but never published still count as used —
  pick a number that has never reached GitHub.
- 7.0.0 is **released** — it was the major bump Dragos reserved to mark the move
  to the company Claude account (everything ≤ 6.26.0 came from the old personal
  account). It carried no breaking change, only the reserved number. The next
  batch is an ordinary minor: 7.1.0.
- `package-lock.json` carries a stale root `version` (6.17.1 while package.json
  moved on). It has been that way since 6.18 and every Docker image since has
  built, because `npm ci` validates the dependency tree and not the root
  version field. Do not "fix" it during a release bump — re-resolving the
  lockfile is a far bigger change than the release it would be riding on.
- Migrations: additive, `IF NOT EXISTS`, never backfill a guess ("an open
  recorded before this release has no country, which is the truth about it").
  Entrypoint runs `prisma migrate deploy` with the privileged URL.

## Cross-wiring that has caused (or nearly caused) bugs

- **Docker runner image does not contain `scripts/`.** The integrity manifest
  (`scripts/build-security-artifacts.mjs`, `ROOTS`) must hash exactly what the
  runner stage copies — adding a root without checking the Dockerfile produced
  false CRITICALs. Ops scripts (backfills) must be `docker cp`'d in or run from
  the host.
- **Security scan `checkId`s are stable identity.** The weekly diff
  (`newlyAlarming`) and history compare by checkId; rename titles freely,
  never checkIds. Warn/fail titles state the OBSERVATION ("10 high
  vulnerabilities"), pass titles state the desired state. Daily scans run a
  `daily: true` subset; weekly runs everything.
- **Notifications** (src/lib/inapp-notifications.ts): fire on the FIRST
  non-copied comment per version only; recipients = uploader + every
  PROJECT_MANAGER minus the actor; dedupe per (recipient, video, type). Every
  silent exit must log which rule fired — silent exits hid a dead PM lookup for
  months.
- **Pasted comments** (`isCopied`): excluded from the first-comment count,
  greyed in UI, not editable, carry `sourceVideoId`/`sourceVersionLabel`.
  Attachments copy as new VideoAsset rows **sharing the same `storagePath`**
  (never duplicate bytes); always carry `storageBackend`/`storageLocations`
  across. Deletion refcounts rows sharing a path before removing the file.
- **AnnotationOverlay** shows a saved drawing only when its comment is
  `activeCommentId` (AND the playhead is in its window). Play clears the
  selection. Do not go back to time-only visibility — it fires randomly during
  playback (200ms clock vs ~83ms windows).
- **AccessAttempt** is platform-level (no organizationId, prismaPrivileged);
  **SharePageAccess** is org-scoped. Both purge at `ACCESS_RETENTION_DAYS`
  (90) in the worker; the scan's retention check counts BOTH tables.
- Geo: prefer the `CF-IPCountry` header, fall back to local MaxMind — one
  helper, `resolveRequestGeo()` in src/lib/geoip.ts. Country NAMES come from
  `Intl.DisplayNames` (src/lib/country.ts) because the header carries only a
  code. `country.ts` is browser-safe; `geoip.ts` is not (MaxMind import).
- **Org deletion**: `deletionScheduledAt` stores T0 (grace already added at
  request time, `ORG_DELETION_GRACE_MS` = 30d). Days-remaining is plain
  subtraction — the tenant banner and the founder "Leaving" panel must use the
  same arithmetic. `deletionReason` is optional, cleared on cancel; retention
  metrics count a scheduled deletion as churn immediately.
- **Sessions**: refresh token in HttpOnly cookie at Path=/api/auth; device
  fingerprint is `browser:platform` with versions stripped
  (src/lib/device-signature.ts) — raw-UA hashes broke everyone on browser
  auto-updates. In token rotation, `rememberRotationSuccessor` MUST run before
  `revokeToken`.
- **Version stacks**: membership is `stackId`, `name` is display-only,
  `version` is position 1..N renumbered by one canonical helper. Do not infer
  membership from names — that was the 6.0.x bug family.
- Menus are OPAQUE (`brand-menu-surface` + inline color-mix + translateZ(0)
  isolation for iOS); `glass-panel` is for page panels, never menus. The
  canonical player timeline/volume styling lives in CustomVideoControls —
  compare mode copies it exactly, including the `bg-black` wrapper that keeps
  the translucent bar from going blue.

## Style

Comments explain WHY at paragraph length, often with the history of the bug
they prevent — match that. Changelog and commit messages are narrative English
prose; the first line names the user-visible truth. New UI strings go in
`src/locales/en.json`. When a check/report/log can be wrong in a reassuring
direction, prefer the honest-but-uglier output.
