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

- `prisma generate` **works** here again (verified 2026-08-27 while adding the
  Feedback models). After a schema change just run it and the typed delegates
  are real — no more patching `node_modules/.prisma/client/index.d.ts` by hand
  and no `as any` on the data object. If it ever starts 403'ing on
  binaries.prisma.sh again, that patch-and-restore trick is what to fall back to.
- Hand-written migration SQL can be checked without a database:
  `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma
  --script` prints what Prisma would generate, which is what the additive
  `IF NOT EXISTS` version has to match column for column.
- **RLS can be exercised locally.** The dev database is a superuser, so RLS
  filters nothing there — but the restricted `framecomment_app` role exists
  in the dev database too (the RLS migration creates it NOLOGIN) and since
  2026-09-09 it has LOGIN with password `localtest`. Run a tsx script (or a
  route) with
  `DATABASE_URL=postgresql://framecomment_app:localtest@127.0.0.1:5432/framecomment?schema=public`
  and `DATABASE_URL_PRIVILEGED` unset, and every unarmed query fails the
  way it fails on production. This is how the 7.7.1 VAPID 500 was
  reproduced before it was fixed; any code that touches the database
  outside an authenticated request (public routes, worker, boot) should be
  tried this way before release.
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
- 7.0.0 is **released** — the major bump Dragos reserved to mark the move to the
  company Claude account (everything ≤ 6.26.0 came from the old personal
  account). It carried no breaking change, only the reserved number, and shipped
  just the version-badge sizing. 7.0.1 followed with the compare-mode playback
  fix.
- **Scale the number to the change.** A bug fix or small UI change takes a PATCH
  bump (7.0.0 → 7.0.1), not a minor — that is Dragos's call, made when a
  compare-mode fix was about to be numbered 7.1.0. Save minors for actual
  features.
- **Before amending "the unpushed commit", verify it is still unpushed.** Run
  `git fetch origin --tags` and compare against `origin/main`; do not trust the
  absence of a push in the conversation. Amending a commit he has already pushed
  rewrites published history: `git push` then wants a force, the tag push is
  rejected with "would clobber existing tag", and the recovery is
  `git reset --soft origin/main` plus a fresh patch version. This happened on
  2026-08-24 — he pushed 7.0.0 while the compare fix was still being written,
  and the amend had to be unwound into 7.0.1.
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
- **Bell → web push** (7.7.0): every bell row published through
  `publishNotification` is also pushed to the recipient's enrolled devices
  (src/lib/push-notifications.ts `sendBellPush`), unconditionally — the
  per-device event switches only govern the company-wide broadcasts. The
  lookup runs through the ARMED client, so a caller outside the recipient's
  org context (today: the founder answering feedback) must pass
  `{ organizationId }`; without it RLS matches zero devices, silently. VAPID
  details are per call, never `setVapidDetails` (module-global, races across
  companies). Push is about COMMENTS only (7.8.3): every device carries
  `subscribedEvents = ['CLIENT_COMMENT']` (migration `push_comments_only`
  set the existing rows and the column default), the entry bar enrols with
  the same, and the Settings section for it is hidden — reachable at
  `/admin/settings?section=notifications` as a debugging door. All pushes
  about one video's comments share the tag `comments:<videoId>` so a person
  gets one notification per video, not one per sender path. Pushes are
  persistent (`requireInteraction` defaults to true in the service worker)
  and sent with `urgency: 'high'`; a true "Time Sensitive" interruption
  level does not exist for web push on any platform (7.8.4).
  `runWithOrgContext(org, fn)` only covers what `fn` AWAITS
  inside it: a bare `prisma.x.find…()` returned from `fn` is a lazy
  PrismaPromise that executes at the outer `await`, outside the context, and
  under RLS that reads as "no rows" — make `fn` an async function that awaits
  its queries. Devices enrolled by the entry bar start with NO broadcast
  events (`initialEvents: ['CLIENT_COMMENT']` since 7.8.3); Disable in Settings sets `fc:push-opted-out`
  so the bar never re-enrols that browser. **Notification icons are PNG**
  (`/brand/icon-192.png`, rendered by sharp from the brand SVG): macOS accepts
  only raster attachments and silently drops the WHOLE notification for an
  SVG icon while the push service reports it delivered (7.8.1).
- **Tier ladder** (7.9.0): which tiers a source gets is decided in ONE pure
  function, `planTierSlugs` (src/lib/tier-ladder.ts). The worker's
  `computeProgressiveTiers` maps it to dimensions; the status API predicts
  with it (`plannedTiersPredicted`) from the dimensions the browser probes at
  upload (`/api/videos` accepts `width`/`height`), or from the project cap.
  Change the ladder in one place or the banner and the worker disagree. The
  processing list keeps READY rows whose ladder is unfinished (JSON columns,
  filtered in JS after a 6h-bounded query), and the banner's tally
  (src/lib/tier-tally.ts) holds a vanished video for two polls before folding
  it as finished — the pre-7.9.0 "fold on first disappearance" produced
  "25 / 27" for four uploads.
- **Upload / encoding banners are personal, the cards are not** (7.10.0):
  `/api/processing-status` still returns the company-wide in-flight list —
  `VideoCard` reads it to paint the progress bar on every colleague's card —
  but each row carries `isMine` (`Video.createdById` = viewer) and the
  response carries `mineCount` per state; `ProcessingStatusContext` exposes
  them as `mine`, and only `ProcessingStatusBanners` renders `mine`. Do not
  filter the API by uploader: that hides the cards' progress for everyone
  else. A reprocess or speed change re-encodes an EXISTING row, so its banner
  goes to the original uploader, not to whoever pressed the button; a row
  with no `createdById` is in nobody's banner.
- **Comment composer line height is an inline style** (7.10.0): the base
  `<Textarea>` carries `sm:text-sm`, and in Tailwind 3 a responsive `text-*`
  re-declares `line-height` in a variant rule emitted after every plain
  utility, so a `leading-*` class on the composer silently loses from the sm
  breakpoint up. 7.8.0's `leading-6` never applied on desktop; the timecode
  chip (20.5 px + 2 px) reached into line two and an emoji there sat under
  it, reported twice. `COMPOSER_LINE_HEIGHT` in CommentInput is the fix; the
  text uses a FIRST-LINE indent (`textIndent: chipGutter`) so it wraps under
  the chip like the posted comment does — do not turn it back into padding.
  Lists in both boxes go through ONE helper, `handleListKeydown`
  (src/lib/comment-list-keys.ts): Space after "1." at a line start indents
  with `LIST_INDENT` (literal spaces, the only indent a textarea can show),
  Shift+Enter continues, Backspace right after a fresh marker un-lists, and
  a lone empty marker continues instead of ending the list.
- **A release invalidates every chunk a still-open tab may ask for** (7.10.1):
  chunk names carry the build hash and the image is replaced whole, so an old
  page's first lazy import after a deploy fails with "Loading chunk N failed".
  `src/app/error.tsx` recognises that (src/lib/stale-chunk.ts) and reloads
  ONCE per minute per tab, via sessionStorage; a second failure shows the card
  with the reason. `public/sw.js` has NO `fetch` handler on purpose — it is a
  push-only worker; the old pass-through handler cached nothing and only added
  a way for loads to fail on iOS. The player sets `navigator.mediaSession
  .metadata` (title = video, artist = project, artwork = poster) so the iOS
  lock screen shows the thumbnail instead of the app icon.
- **Fixed-id jobs must replace a FINISHED job, not be swallowed by it**
  (7.12.0): BullMQ's `queue.add(..., { jobId })` is a no-op while any job
  with that id exists — completed ones are kept 1 h, failed ones 24 h — so a
  "Regenerate thumbnail" click after one failure did nothing for a day while
  the route said success. Use `addJobReplacingFinished` (src/lib/queue.ts)
  for every fixed-id job; it removes a completed/failed job first and reports
  'already-queued' for one still running. The regenerate job reads an encoded
  TIER (720p first, src/lib/thumbnail-source.ts) whenever the master is not
  on local disk — the master of a 25-min 4K clip is tens of GB and the
  worker's /tmp is a memory disk. The folder banner polls the job's state
  (GET on the same route) and reports `failed` with the worker's reason
  instead of closing with "Thumbnail updated" after a minute.
- **Touch stacking is a hold-then-drag, in one hook** (7.13.0): phones have
  no HTML5 drag, so `useTouchStackDrag` (src/lib/use-touch-stack-drag.ts,
  rules in src/lib/touch-stack-drag.ts) listens natively on the grid — React
  touch handlers are passive and cannot stop the page scrolling under the
  held card. Hold 400 ms without moving → the card lifts (`draggingVideoId`
  is shared with the mouse path, so the same dimming applies), the card under
  the finger gets `isStackHoverForced`, lifting there calls the same
  `handleStackVideos`. Mouse users never enter it; do not add touch handlers
  to VideoCard itself — a second gesture owner is how taps stop opening.
- **The comment composer is the paste and drop target for files** (7.13.0):
  `extractImageFiles` (src/lib/clipboard-files.ts) reads BOTH `items` and
  `files` and accepts by type or extension — a Finder-copied image can carry
  an empty type. A paste that lands on no other text field goes to the
  visible composer (document listener; the phone layout mounts a hidden
  second CommentInput, so the visibility check is what stops double
  uploads). The composer wrapper carries `data-comment-dropzone`;
  GlobalDropOverlay hides while a drag is over it and is never shown on the
  player page (`/admin/projects/<id>/share`), where nothing uploads a drop.
- **A deep-linked comment is highlighted like a clicked one** (7.13.1):
  `focusCommentInList` calls `selectFromClick` (via a ref) so the THREAD's
  card gets the `.is-picked` ring — never the reply row — plus a 2 s
  two-pulse glow. The glow is a keyed child layer (`.comment-focus-glow`,
  `focusGlowKey` prop on MessageBubble, nonce state in CommentSection), not a
  class toggled on the card: `.is-picked`/`.is-selected` paint their rings
  with `!important` and a CSS animation ranks below `!important`, and a
  DOM-added class is wiped by the selecting re-render; the remount restarts
  the animation and `both` parks it at opacity 0 if the removal is late.
- **Author names are Unicode; the ASCII rule is for ffmpeg only** (7.13.1):
  `sanitizeAndValidateContent` (src/lib/comment-helpers.ts) rejects only `<`,
  `>` and control characters in `authorName`, cap 100 like `User.name`. It
  used to apply the watermark whitelist `[a-zA-Z0-9\s\-_.()]`, so a staff
  member named Ștefan could not post any comment or reply — every request was
  a 400 "Invalid characters in name", reported as "his browser". That
  whitelist stays where ffmpeg drawtext actually runs (watermark text in
  settings/projects and src/lib/ffmpeg.ts) and nowhere else.
- **Android never gets browser fullscreen** (7.13.3): every Chromium
  browser on Android answers `requestFullscreen()` with its own notice —
  "framecomment.com – to exit full screen, drag from the top and touch the
  back button" — drawn by the browser process (ExclusiveAccessManager, a
  persistent snackbar since spring 2026); no CSS, API or option hides it.
  So on Android (`prefersInPageFullscreen`, src/lib/in-page-fullscreen.ts,
  by user agent) the player fills the viewport itself: container class
  `fc-inpage-fullscreen` (fixed, inset 0, z-90, fill rules shared with
  `:fullscreen` in globals.css), `isFullscreen` set by hand so the floating
  bar behaves as in real fullscreen, and ONE history entry so the Back
  gesture leaves fullscreen instead of the page (`popstate` listener; the
  marker in `history.state`). Rotate-to-fullscreen goes through the same
  path there. Every exit — button, Back, `ended`, the Save-speed dialog —
  runs through `exitFullscreenIfActive`; do not add a
  `document.exitFullscreen()` next to it, it does nothing for this mode.
  iPhone/iPad keep native/element fullscreen (WebKit has no such notice).
- **Pasted comments** (`isCopied`): excluded from the first-comment count,
  greyed in UI, not editable, carry `sourceVideoId`/`sourceVersionLabel`.
  Attachments copy as new VideoAsset rows **sharing the same `storagePath`**
  (never duplicate bytes); always carry `storageBackend`/`storageLocations`
  across. Deletion refcounts rows sharing a path before removing the file.
  A pasted note marked Done is dropped from "All comments" and from the
  timeline pins (7.13.1, `isRetiredCarryOver` in src/lib/comment-visibility.ts
  — one predicate for the list AND the player); "Completed comments" still
  lists it, nothing is deleted, and so does the "Copied comments" filter
  (`commentsFilter === 'copied'`, `isCopied` done or not). A comment written
  on the version itself only greys out when done.
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
  membership from names — that was the 6.0.x bug family. The player pages
  key their groups by display name and call a second stack with the same
  name "<name> (2)", so every link into a player must carry the STABLE id
  (`?videoId=`) as well as the name (7.9.1): the grid, the table, e-mail and
  push deep links all do, and both player pages resolve the group by id
  first. Two identical filenames (a 4:5 and a 9:16 cut) opened the wrong one
  without it.
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
