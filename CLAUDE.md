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
- **Deploy is automatic since 7.17.6** (DEPLOY_TRUENAS.md, in Romanian): the
  tag builds the image (~6 min), the release workflow moves `:latest`, and
  Watchtower on the TrueNAS box (`ix-watchtower-watchtower-1`, interval 300 s)
  recreates `framecomment-app` and `framecomment-worker`, which run
  `dragosonisei/framecomment:latest` since 2026-10-02. Nobody edits the app
  in TrueNAS for an update any more. A release is confirmed live when
  `https://framecomment.com/api/health` reports the new `version` (field
  added in 7.17.6, `NEXT_PUBLIC_APP_VERSION` baked from the tag). Watch
  Docker Hub (`/v2/repositories/dragosonisei/framecomment/tags/<v>`) for the
  build, then health for the deploy; 6–11 minutes in all. Postgres and Redis
  are never added to Watchtower's list. Rollback = a fixed tag (no "v") on
  both images via `midclt call app.update framecomment …` (recipe in the doc;
  a TrueNAS-side update restarts the whole stack, Watchtower only the two).
  Dockerfile stays non-standalone on purpose: the worker needs the full
  node_modules (tsx) and the boot gain would be small.
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
  CLIENT_COMMENT broadcast itself is narrowed per video since 7.17.0
  (`clientCommentAudience`, src/lib/push-audience.ts): content-only roles
  (level 50 — Editor, Senior Video Editor, Team Leader, Marketing,
  Producer) get it only for a video they uploaded; Owner, Admin and
  Project Manager get every one. Alin's Mac rang for Victor's cut before
  that. The uploader is `Video.createdById`; a legacy row without it
  reaches the privileged roles only.
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
  A CLICK on a system notification (7.16.1) goes through the same path as a
  bell row: the service worker (`notificationclick` in public/sw.js) picks
  the focused tab of this origin, focuses it and posts `fc:open-url`;
  `ServiceWorkerProvider` (root layout — the bell is not mounted on the
  player page) answers on the port, `router.push`es and fires
  `comment:focus`. Only when no tab answers does the worker `navigate()` or
  `openWindow()`. `data.url` must be the in-app deep link
  (`notificationDeepLink`), never the e-mail link: the client-comment
  broadcast carried `/login?returnUrl=…` and a click opened the sign-in
  form, because /login does not forward a live session. The worker still
  unwraps a same-origin /login link for notifications delivered before.
  Chrome on macOS 15+ often LOSES the click before the worker sees it
  (Chromium 370536109 / 375640809: Chrome comes forward, no
  `notificationclick`), reported mostly for the persistent "Alerts" style
  delivered by Google Chrome Helper (Alerts). Nothing in the page can see
  or repair that, so the worker announces every click it does receive
  (`fc:notification-clicked`, before anything else) and Settings →
  Notifications' test shows a 4th step — click reached us, or not — with a
  "Test as banner" twin (`persistent: false` → `requireInteraction:
  false`) to compare the two styles on a device. A TEST click only focuses
  a tab; navigating would take away the page reporting the result.
  Measured 2026-09-25 on Dragos's Mac: the persistent alert's click never
  arrived, the banner's did. So on macOS (`IS_MAC` in sw.js, by user agent)
  every notification is shown with `requireInteraction: false` — a banner
  that slides into Notification Center and CAN be opened — except the
  Settings test's persistent variant, kept to see when Chrome fixes it.
  Other platforms keep 7.8.4's persistent notifications.
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
  The list's "scroll to the newest comment" effect (on `displayComments
  .length`) yields while a deep link lands (`focusScrollGuardRef`, 7.15.0):
  it fired as the list filled, cancelled the smooth scroll to the target
  midway and left the first card half under the panel's top edge — "no
  highlight for comments, only for replies", because replies sit mid-list.
  Two settle checks re-scroll without animation if the card is not fully
  inside its scroller.
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
- **Premiere markers come in through the paste loop, untagged** (7.14.0):
  `src/lib/premiere-markers-import.ts` reads a Final Cut Pro 7 XML with its
  own small tree reader (no DOMParser, so a node script exercises the same
  code on a real Premiere export), takes the `<marker>` children of every
  `<sequence>` that has no `<clipitem>` ancestor — clip markers and nested
  sequences are not imported, by decision — converts frames at the
  SEQUENCE's rate (`<timebase>` + `<ntsc>`) to seconds and to a timecode at
  the VIDEO's rate, skips markers past the video's end and ones identical
  to a comment already there (same ms, same text), and posts through
  `pasteClippedThreads` with `isCopied: false`. That flag exists for this
  caller alone: a "Copied" import would grey out and, once done, hide an
  editor's own notes. Text is name on the first line, comment below, HTML
  characters escaped. Admin only, like the .srt export, in the same kebab.
- **Comments export as .srt, never overlapping** (7.15.0): the kebab's
  export is `buildCommentsSrt` (src/lib/comments-srt.ts): one cue per
  moment, `timestampMs` preferred over the frame-rounded timecode, author
  prefixed, blank lines removed (a blank line ends
  an SRT cue), same-frame notes merged into one cue, a point note shown for
  4 s and cut short when the next arrives — Premiere puts an .srt on ONE
  caption track and two captions cannot share a moment. UTF-8 with BOM and
  CRLF so Premiere/Windows do not read ș/ț as Latin-1. The SET is the
  editor's to-do list (7.15.1, `exportableComments`): top-level, not
  `isCopied`, not `isResolved`, and no replies in the text — the builder
  still accepts replies for a future "everything" export. The 7.8.0 Final
  Cut XML builder stays in premiere-markers.ts (the import round-trips
  through it) but has no menu item.
- **A failed avatar fetch is not the answer** (7.14.1): `UserAvatar`
  caches a person's photo per page load, and the first version cached a
  FAILED fetch the same way — so one refused `/api/users/[id]/avatar`
  (rate-limited burst, expired token, network blip, deploy mid-request)
  meant initials for that person on every note until a reload. The policy
  is `createAvatarStore` in src/lib/avatar-cache.ts (pure, exercised by a
  node script with a failing fetcher): a photo is kept for the session,
  404 for a minute, a transient refusal for a 2–30 s backoff, and the
  mounted hook retries when it ends. A photo already known wins over a
  payload whose author carries no `hasAvatar` — and every route that
  returns comments with `user` must select `avatarUrl`, because the
  sanitizer derives the flag from it (`/api/projects/[id]` and the share
  comments route did not, until 7.14.1).
- **Edit is the author's alone; Delete is moderation** (7.16.0):
  `canEditComment` in CommentSection decides the Edit button on cards and
  reply rows AND the right-click Edit item — staff own comments carrying
  their `userId`, guests the ones carrying their session id
  (`isMyComment`). Admins still see Delete on everything. This is UI only:
  PATCH /api/comments/[id] keeps letting an admin change any comment
  because dragging a range on the timeline goes through the same route on
  anyone's note; do not tighten it without moving that first.
- **Esc is Back only when it closed nothing** (7.17.0): `EscapeBack`
  (root layout, rules in src/lib/escape-back.ts) presses the page's Back
  control — a real click on the element carrying `data-esc-back` (project,
  folder, analytics, the player's reel pill) — and only when (1) at capture
  time, before any handler ran, focus is not in a text field, nothing in
  `ESC_LAYER_SELECTOR` is open (dialog/menu/listbox/aria-modal/
  `data-esc-layer`) and the player is not fullscreen, and (2) after the
  dispatch, no handler called `preventDefault()`. So every Esc handler that
  closes something WITHOUT a role on its popup must call
  `e.preventDefault()` (the bell panel, player settings, Feedback, the
  timeline marker popover, compare, the attachment viewer do); a new one
  that forgets makes Esc close it AND leave the page. Project settings has
  no `data-esc-back` on purpose: Esc after an edit would drop unsaved
  changes.
- **Billed storage never asks the environment** (7.17.2): `fcStorageWhere()`
  (src/lib/billing.ts) counts rows tagged fc, rows kept on fc after a
  transfer, AND untagged pre-4.2.0 rows, unconditionally. It used to include
  the untagged rows only when `legacyBackend()` resolved to fc — a function
  of THIS PROCESS's env (STORAGE_PROVIDER / DEFAULT_STORAGE_BACKEND /
  FC_S3_ENDPOINT) plus a module cache that only an org-1 Settings read
  fills, whose 30 s refresh stamp every company's call shares — and the
  Billing page and the invoice are computed in two different processes
  (web container, worker container). On 2026-10-02 both containers had
  STORAGE_PROVIDER=local and no S3 endpoint; the web process had org-1's
  chosen 'fc' in the cache and counted CPC's 2.9 TB, the worker's cache was
  empty, env said 'local', and the invoice counted 328 GB: $331.80 instead
  of $596.20, the second under-collection in two months. The 7.4.3
  verification gate cannot see this class of bug — both of its
  recomputations run in the worker. Rule: everything that feeds `computeBillingUsage` comes from the
  database or from constants, never from `process.env` or a process-local
  cache. `chargeInstance` logs the basis (users, GiB tagged + untagged) so an
  invoice can be audited from the worker log alone. Re-collecting after a
  refund: `/admin/settings?section=billing&retry-payment=1` → "Retry payment"
  (two-step, runs `chargeInstance` in the web process, anchor untouched).
- **The grid and the player's arrows share ONE comparator** (7.17.3):
  `compareBySortMode` (src/lib/sort-mode-compare.ts) orders the folder
  grid's cards (FolderBrowser, folders and video groups) AND the version
  reel's previous / next list (ThumbnailReel `sortMode`, passed by the
  admin player page as `isMobile ? 'alphabetical' : adminSortMode`, the
  same fallback FolderBrowser applies). The reel used to sort plain A→Z, so
  with the grid on "Oldest → Newest" the first card showed a "previous"
  arrow and "next" went to the alphabetical neighbour. A group's date is
  its latest version's `createdAt`, which both callers read from the
  latest-first row; equal dates fall back to the name. The public share
  player passes no `sortMode` and stays A→Z. Never put a second inline
  sort switch next to either caller.
- **A card never streams a long video to scrub it** (7.18.8): the `<video>`
  fallback for rows without a storyboard sprite is allowed only up to
  `LEGACY_SCRUB_MAX_SECONDS` (180, src/lib/card-scrub.ts, pure,
  node-tested). On live, two 37-minute 4K interviews without sprites made
  every hover a storm of 4 MB range requests (108 MB per crossing), the
  rate limiter's Redis timed out under it and answered 503 — "fail
  closed" in rate-limit.ts — and the preview showed nothing. Instead, an
  admin hovering a READY, encoded video with no sprite fires ONE
  `POST /api/videos/[id]/regenerate-thumbnail` with `{ storyboardOnly:
  true }` per card per page (`shouldRequestStoryboard`); the job rebuilds
  only `storyboardPath` and leaves the cover alone — the full run would
  overwrite a custom thumbnail with an auto frame, which no hover may do.
  Guests never trigger work. Both sweeps still run full jobs.
- **Folder covers are fetched per folder** (7.18.7): `fetchFolderPreviewData`
  (src/lib/folder-previews.ts) used to run ONE query over every folder on
  the page with a shared cap, newest first — so a folder whose videos were
  older than its siblings' fell outside the cap and showed the glyph over
  "3 items" (CLEAN next to 9:16 and 4:5 on live). One query per folder
  now; never reintroduce a cap shared across folders.
- **Quick Look is as wide as the video, never as wide as the title**
  (7.17.3): in video mode QuickPreviewOverlay's card carries `--qp-w` =
  `min(95vw, PREVIEW_MEDIA_MAX_VH vh × aspect)` (class `sm:w-[var(--qp-w,
  auto)]`; folder mode leaves the variable unset) and the media box uses the
  same `PREVIEW_MEDIA_MAX_VH` cap — change one and the card and the media
  disagree. The title is one line fitted with a MIDDLE ellipsis
  (`middleEllipsis`, src/lib/middle-ellipsis.ts — pure, canvas-measured by
  `MiddleEllipsisTitle`, refit on resize, full name in the tooltip); CSS
  `text-overflow` cuts the end, which is where "_9×16_V7" lives.
- **The composer's timecode chip scrolls with line one** (7.17.4): the
  chip is absolutely positioned over the textarea (a textarea has no
  children), so on a long comment the text scrolled under a pinned chip.
  `syncChipToScroll` in CommentInput (textarea `onScroll` + the auto-resize
  effect) translates the chip by `-scrollTop` and clips the part above the
  box with `clip-path: inset(scrollTop − CHIP_TOP_PX …)`; `CHIP_TOP_PX` must
  equal the chip's `top-[2px]`. Both are declared with the other refs,
  BEFORE the auto-resize effect that lists the callback in its deps and
  before `commentsDisabled`'s early return — a later `const` is in its
  temporal dead zone when the deps array is built (crashed the first
  attempt) and a later hook is a conditional hook. The textarea carries
  `custom-scrollbar`, the shared themed bar; it was the one text box still
  showing the browser's grey-on-white one.
- **The comment edit box grows to a ceiling, then scrolls** (7.17.5):
  `EditTextarea` in MessageBubble measures `scrollHeight`, checks itself
  once (content still overflowing → add the gap), re-measures on parent
  width changes and `document.fonts.ready`, and stops at `EDIT_MAX_VH`
  (45%, never under 160 px) with `overflow-y: auto` + `custom-scrollbar`.
  The 3.9.x "no inner scrollbar, ever" box was exactly as tall as one
  mount-time measurement; on Dragos's phone that came up a line short and
  the end of a long comment was unreachable. Do not return to overflow
  hidden with no ceiling.
- **A click outside an open edit closes it only when nothing changed**
  (7.17.6): `shouldExitEditOnOutsideClick` (src/lib/edit-outside-click.ts)
  decides; MessageBubble binds ONE capture-phase `pointerdown` listener per
  edit session (comment or reply, `editBoxRef` on whichever box is open).
  Never closes for a click inside the box, in a popup layer, in the comment
  composer (`data-comment-dropzone` — it attaches files and drawings to the
  open edit) or while drawing mode is on. "Unchanged" compares against
  `htmlToPlainText(content)`, the value the edit started from.
- **On desktop the admin shell is the viewport; the content column scrolls**
  (7.17.9): the chromed branch in src/app/admin/layout.tsx is
  `md:flex-none md:h-dvh md:overflow-hidden`, the column beside the sidebar
  `min-h-0 md:overflow-y-auto`. The window never scrolls from md: up, so the
  sidebar (and the sticky top bar inside the column) cannot move. Two
  earlier attempts failed and are worth knowing: `sticky` alone broke
  because an ancestor carried `overflow-x-hidden` (any non-visible overflow
  makes that ancestor the sticky's scroll container), and `h-dvh` alone was
  ignored because the shell is a `flex-1` item of the root layout's column
  — flex-basis decides a flex item's main size before `height` does, so
  `flex-none` is what makes the height stick. The column is also
  `relative` (7.17.10): a scroll container clips only descendants whose
  containing block is inside it, and an `absolute` element positioned
  against an ancestor above the column escaped the clip, stretched the
  document and put a second (window) scrollbar next to the column's on
  the folder page. Two scrollbars on an admin page always mean a
  descendant escaped the column — look for the containing block before
  touching overflow. Phones keep document
  scrolling (hidden sidebar, collapsing address bar). Pages scroll inside
  their own `overflow-y-auto` boxes, as Settings always did; every popover
  listens for `scroll` in the capture phase, so they still close/reposition.
  Scrollbars are themed GLOBALLY since 7.17.9 (universal rules at the end
  of globals.css, outside the layers): a new scroller never needs
  `custom-scrollbar`, which is now a no-op; `scrollbar-hide` still works.
- **Four media kinds, decided in one place** (7.18.0): `MediaType` is
  VIDEO | IMAGE | AUDIO | DOCUMENT and `src/lib/media-kind.ts` owns the
  extension/MIME lists, `mediaKindFromFile` (the upload route), the chip
  labels (`mediaKindLabel`: Video 9:16 / Image / Audio / PDF / Text /
  Word), `skipsEncoding` (IMAGE, AUDIO, DOCUMENT never reach the worker —
  both upload hooks flip them READY; only an image's original doubles as
  its thumbnail; audio gets its duration from ffprobe when the bytes are on
  local disk) and `originalContentType` (the content route's Content-Type
  for originals — an .mp3 served as video/mp4 under nosniff may not play).
  Audio and documents stream the ORIGINAL: the share token route mints
  'original' for them regardless of `allowAssetDownload`, both players fill
  every stream slot with it, and the share project payload carries
  `mediaType` (it did not, so a document sat on "Loading Video…"). AUDIO
  plays in VideoPlayer over an artwork overlay with timeline comments and
  no quality badge; DOCUMENT renders in `DocumentViewer` (pdfjs-dist for
  PDF, mammoth + DOMPurify for .docx, `<pre>` for .txt — wheel zoom, drag
  pan, ↑/↓ pages) in place of the player, with NO comments column; the
  reel's `selectVideoVersion` event is answered by a page-level listener
  declared with the state (a hook after the early returns is conditional).
  The pdf.js worker is copied to public/vendor by
  scripts/copy-pdf-worker.mjs (`predev` / `prebuild`, gitignored).
  Documents stop at 500 MB (`DOCUMENT_MAX_BYTES`). Every private extension
  list that still exists is a bug: the TUS hook had one and rejected the
  first .mp3/.pdf/.txt with a 500 after the row was created.
- **A document's cover is the top of page one, painted by the worker**
  (7.18.0): `src/lib/document-thumbnail.ts` renders a 1280×720 JPEG (page
  scaled to the card's width, cut at the bottom — the title is up there in
  99% of briefs) with pdf.js's Node build + `@napi-rs/canvas` for PDF,
  mammoth → blocks for .docx and the first lines for .txt, drawn with the
  Liberation Sans that ships inside pdfjs-dist (the runner has no Arial).
  It runs in the regenerate-thumbnail job ONLY: both upload hooks and the
  duplicate route enqueue `enqueueRegenerateThumbnail` for a DOCUMENT
  right after marking it READY, and the per-video button reaches the same
  branch; AUDIO is skipped there with a log (ffmpeg has no frame to grab).
  Never import that module from src/app — webpack would try to bundle the
  native binding. The binding is per libc: `npm ci` runs on Alpine (musl)
  and the runner is Debian (glibc), so the Dockerfile's runner stage packs
  the matching `@napi-rs/canvas-linux-<arch>-gnu` from the registry into
  node_modules and loads it once as a build-time check. Because the cover lands a second AFTER the
  upload-complete refresh, the project and folder pages poll through
  `anyStillSettling` (src/lib/live-refresh.ts): a READY document without
  a cover counts as in flight for two minutes after `createdAt`, then
  stops — a failed render must not keep every visitor polling forever.
- **Audio is proxied, not redirected, and the ring listens to it** (7.18.0):
  `AudioReactiveRing` (around the note in VideoPlayer's artwork) reads the
  sound with a Web Audio analyser on the SAME <video> element — one
  `createMediaElementSource` per element for its whole life (module
  WeakMap), wired analyser → destination at once, `resume()` on every
  `play`. A media element captured this way goes SILENT when its bytes
  come from another origin without CORS, so the content route's S3 branch
  serves AUDIO itself, range by range (`s3GetObjectRange`), instead of the
  presigned redirect every other stream gets; and the ring still probes
  one byte with `redirect: 'manual'` before capturing — on a redirect it
  only breathes on a timer and never touches the element. Quick Look keeps
  its own `QuickAudioBar` and no analyser. The artwork itself (glow,
  frosted circle, resting ring, all from `--spotlight-tint`) is ONE
  component, `AudioArtwork` (7.18.2), on the card, in Quick Look and in
  the player — the player passes the live ring as children and turns the
  static one off. Do not redraw the circle inline anywhere. It takes a
  `glyph` (7.18.4): folders wear it too — an empty folder's cover, a
  folder tile inside a mosaic (smaller, ring only on the big tile) and
  the folder's Quick Look (FolderCard and QuickPreviewOverlay's
  FolderCover).
- **The accent is the company's, fetched WITH the token** (7.18.3):
  `/api/settings/theme` answers with the platform's theme for an anonymous
  caller and with the company's own only when a bearer arms the org.
  `AccentColorProvider` used a bare `fetch`, so a tenant admin page always
  painted the platform's accent (and cached it in localStorage), while
  the Settings swatches, loaded through `apiFetch`, showed the saved
  purple — "pick purple, refresh, it's blue". It now goes through
  `apiFetch` and re-runs when the token store changes (the token arrives
  after first paint). The layout bootstrap script applies a cached
  CUSTOM hex too (it only knew preset keys). The colour saves from its own
  "Save Color" button (`handleSaveAccentColor`, PATCH `{ accentColor }`);
  the tenant auto-save no longer carries it. Any other client of that
  route must use `apiFetch` as well (AdminSidebar does; BrandLogo reads
  only the logo path).
- **Pasted comments** (`isCopied`): excluded from the first-comment count,
  greyed in UI, not editable, carry `sourceVideoId`/`sourceVersionLabel`.
  **A copy is credited to its original author** (7.18.1): the paste sends
  `sourceCommentId` for every thread and reply (comments-paste.ts), and
  POST /api/comments carries the source row's `userId` across for a copy
  by signed-in staff within the same project — null for a guest's note,
  null when the source cannot be resolved. The avatar and a staff name are
  drawn from `userId`, so before this every carried note wore the paster's
  face. Never put `authContext.user.id` on an `isCopied` row.
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
- **The top bar is clear; its controls are frosted** (7.18.6): the
  `<header>` in AdminTopBar stays `bg-transparent` so Back, the search
  pill and the right-hand buttons float, and ONE scoped rule at the end of
  globals.css (`[data-topbar] button…`, menu items excluded) gives every
  control a `backdrop-filter`. Scoped by attribute because the controls
  are rendered into the bar's slots by half a dozen pages. Two things
  learned: a frosted BAR was rejected ("I want the buttons to float"),
  and in the dev pipeline (Turbopack/lightningcss) writing
  `-webkit-backdrop-filter` next to `backdrop-filter` made it emit only
  the prefixed one, which Chrome dropped — write the standard property
  alone and let the pipeline prefix it. Popovers are siblings of their
  buttons, never children: `backdrop-filter` makes an element the
  containing block of its fixed descendants. **Below 1120 px the search pill
  is the search icon**, in the same centre column (7.18.6): the grid never
  shrinks the pill, so at a narrower window it slid under a folder's five
  right-hand actions. A breakpoint, by Dragos's call: a measured version
  (ResizeObserver + MutationObserver on the slots, a content-sized grid in
  compact mode) was built, looked wrong to him, and was reverted — do not
  bring it back.
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
