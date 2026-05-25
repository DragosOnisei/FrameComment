# Changelog

All notable changes to **FrameComment** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Looking for the upstream (ViTransfer) history?** See
> [`CHANGELOG-upstream-history.md`](./CHANGELOG-upstream-history.md). FrameComment
> was forked from ViTransfer 1.0.2 by [MansiVisuals](https://github.com/MansiVisuals/ViTransfer)
> on 2026-05-02 and re-versioned starting at 1.0.0.

---

## [Unreleased]

Planned for upcoming releases. See [GitHub Issues](https://github.com/DragosOnisei/FrameComment/issues)
and [Discussions](https://github.com/DragosOnisei/FrameComment/discussions) for the live roadmap.

## [1.5.0] - 2026-05-25

Share-link controls + admin-link hardening. The headline feature is a
Frame.io-style share modal with auto-copy on open and an opt-in
expiration date (1 day / 1 week / 1 month or a custom calendar
picker) that enforces a hard cut-off on the public share routes,
plus two important security fixes around how share URLs are minted
and how a folder-share recipient is scoped.

### Added

- **Share-link expiration.** The folder/project/video share modal
  now exposes a "No expiration date" toggle (ON by default — links
  never expire unless you opt in). Flipping it OFF reveals quick
  presets (1 day / 1 week / 1 month) plus a native date picker. The
  chosen date is persisted as `Folder.shareExpiresAt` /
  `Project.shareExpiresAt`; once past the cut-off the public share
  routes return `410 Gone` for everyone except admins, and the
  public page renders a friendly "This share link has expired"
  notice with the exact moment it stopped working.
- **Countdown banner on share pages.** Both `/share/[token]` and
  `/share/folder/[slug]` render a thin banner above the player
  showing "Expires in N days (Wed, Jun 3, 2026)" so the recipient
  knows ahead of time when the link will go dark. The banner
  switches to amber once the link is within 24 h.
- **Auto-copy on share modal open.** Opening the share modal now
  silently writes the share URL to the clipboard so the admin can
  paste it straight into the chat they're about to send — the
  Copy button flashes green ("Copied") for ~1.8 s as visual
  confirmation. Falls back to the manual Copy button when the
  clipboard API is blocked (Safari Private Mode, http://, etc.).
- **Folder Download-All on public share.** Recipients of a folder
  share can now bulk-download the whole folder tree as a ZIP that
  preserves both folder structure and original filenames.
  Gated behind the project's existing `allowAssetDownload` flag
  and the folder's share auth.
- **Admin Download-Folder kebab action.** Mirrors the public
  Download All; same ZIP shape so the file the client receives
  matches what the admin would download from the dashboard.

### Changed

- **Project share slugs are now random tokens.** Newly created
  projects mint a base64url-encoded `crypto.randomBytes(9)` slug
  instead of one derived from the project title. Old links
  guessed by title (`/share/myproject`) no longer exist; existing
  rows must be migrated through the one-off
  `scripts/regenerate-project-share-slugs.ts` helper — run it
  once after upgrading. **(Security)**
- **Folder-share breadcrumb stays in scope.** A folder share now
  carries the share-root slug through the URL via `?root=...` and
  the breadcrumb is built server-side by walking the parent chain
  from the current folder UP TO that root only. Recipients can no
  longer pivot from a single shared subfolder to the parent
  project's root and inventory the rest of the studio's work; the
  back/breadcrumb buttons stop at the share root. **(Security)**
- **ShareModal toggle is a real button.** The "No expiration date"
  switch used to be a `<span role="switch">` plus a hidden
  `<input type="checkbox">` inside the same `<label>`; a single
  click fired both handlers in the same tick, the state flipped
  twice, and the toggle felt "stuck" / needed multiple clicks.
  Replaced with a single `<button role="switch">` — one click =
  one flip, plus keyboard Space/Enter and a focus ring for free.
- **Move Up refreshes the folder grid.** Right-clicking a video
  or sub-folder and choosing "Move Up" used to leave the previous
  folder rendering its cached contents — Next.js' router cache
  held on to the old listing until a hard reload, so to the user
  it looked as if the destination had been wiped (the test folder
  vanished). The grid now dispatches `framecomment:folders-changed`
  and calls `router.refresh()` after a successful move so every
  open browser tab pulls fresh contents immediately.
- **Mobile share grid uses kebab, not toggle.** The little
  "All comments" toggle on mobile was replaced with the same
  three-dot kebab menu desktop already uses (Copy / Paste /
  Settings). Cleaner thumb-reachable target, fewer tap states.
- **Copy/Paste comments removed from player top menu.** Those
  actions already live in the comments-panel kebab; the player
  top menu now keeps only Share / Approve / Delete-version.
- **Themed delete-version + delete-asset dialogs.** Both used to
  bounce a native `window.confirm("localhost:3000 says...")` —
  now use the same ConfirmModal as the rest of the app
  (translucent card, destructive red button, full-width buttons
  stacked on mobile).
- **Mobile yellow OUT-handle hit-zone enlarged.** The yellow ball
  itself stays the same visual size, but an invisible hit-zone
  child extends UP and to the sides on mobile only so thumbs land
  on it cleanly without overlapping the white playhead. Hover
  time tooltip is hidden on touch.
- **Worker reads rotation metadata from ffprobe.** Portrait clips
  shot on phones (notably 2160×3840 iPhone exports) used to render
  letterboxed correctly on first paint but then stretched after a
  scrub because the browser swapped to pre-rotation pixel
  dimensions. The worker now reads the Display Matrix rotation
  side-data (and the legacy `tags.rotate`) and swaps width/height
  on the way INTO the DB, so every consumer (player, thumbnails,
  storyboard, downloads) starts with the same display dimensions.
  Also adds `-metadata:s:v:0 rotate=0` to the ffmpeg args so the
  output containers don't carry a rotation flag that browsers
  might re-apply.

### Fixed

- **Reply author label.** Inline replies posted by the admin used
  to show "Admin" instead of the admin's real name (the request
  body wasn't carrying `authorName` for the internal-reply
  branch). Fixed in `useCommentManagement.submitInlineReply`.
- **Next.js 16 `<script>` warning.** The bootstrap inline script
  in `layout.tsx` is now a `next/script` `<Script id="...">` with
  `strategy="beforeInteractive"`, silencing the framework's
  "synchronous Scripts should not be used" console warning.
- **Item count on public folder share.** "Download All" used to
  badge "4 items" while only two cards were visible (it was
  counting raw version rows, not grouped video cards). Now uses
  `videoGroups.length + subfolders.length` so the count, the grid
  and the actual ZIP all agree.

### Migration notes

The `Project.shareExpiresAt` and `Folder.shareExpiresAt` columns
are added by a new Prisma migration. Run on the host before
restarting the app:

```bash
npx prisma migrate deploy
```

Existing rows default to `NULL` (links never expire), so the
upgrade is non-breaking for previously-shared content.

After upgrading, the **one-off** project-slug rotation script
re-keys any pre-1.5.0 projects from their title-derived slugs to
random tokens. Run it once and only once:

```bash
npx tsx scripts/regenerate-project-share-slugs.ts
```

Old share URLs that used the title-derived slug will return 404
after the rotation — re-send the new link from the project page.

## [1.4.0] - 2026-05-25

Major UX release built around a Frame.io-style player toolkit:
production-friendly comment range selection, an in-player settings
menu with quality switching, social-media safe-zones, draggable
rulers, and a one-click frame export. Plus a pile of polish work
on comment threading and the timeline popover.

### Added

- **Player settings menu (gear icon).** The old read-only SD/HD/4K
  badge is now a real gear button that opens a Frame.io-style popup.
  Submenus open on hover (with a 180 ms grace period for cursor
  travel) and slide in with a subtle 200 ms fade. Contains:
  - **Quality switcher** — Auto / 1080p / 720p / 540p / 360p,
    showing only the variants the worker actually produced for this
    clip. The choice is persisted per browser in
    `localStorage['framecomment:playerQuality']`, defaulting to
    "Auto" (which honours the admin's `defaultQuality` setting).
  - **Guides (social safe-zones)** — Off / 9:16 Shorts / 4:5 IG
    Feed / 16:9 YouTube. Draws the platform's crop frame on top of
    the video plus translucent red zones where the platform's own
    UI (like / share / comment buttons, title strip, transport
    overlay) sits — so you can immediately see if a title card or
    important element collides with native UI.
  - **Rulers** — toggle for a Premiere/Photoshop-style ruler strip
    along the top + left of the video. Drag DOWN from the top ruler
    to spawn a horizontal guide, RIGHT from the left ruler for a
    vertical guide. Drag a guide back onto its ruler — or double-
    click it — to delete it. Guide positions are stored as
    fractions of the painted video rect, so they survive resizes,
    aspect-ratio changes, and orientation flips.
  - **Download Still** — captures the current frame at the SOURCE
    resolution (`video.videoWidth × video.videoHeight`, not the
    rendered size) and downloads a PNG named
    `<clipname>_<HH-MM-SS-FF>.png`. Frame-accurate stills for
    deliverables, contact sheets, or PSD comp work.
- **Always-on yellow OUT handle.** The comment-range workflow was
  rebuilt from scratch: a yellow ball is permanently visible on top
  of the white playhead. Grabbing it snapshots the IN point at the
  white ball's position and the yellow follows your finger /
  cursor; the video scrubs underneath so you can see the exact OUT
  frame; the white ball stays frozen at IN. Release saves the range
  and the comment input picks it up via an atomic
  `setCommentRange` event. Tapping anywhere else on the timeline
  clears the range and snaps both balls back together.
- **Themed delete-comment dialog.** Replaces the native
  `window.confirm()` ("localhost:3000 says...") with the same
  ConfirmDialog used for project/archive deletes — translucent
  card + destructive red button + Cancel.

### Changed

- **Inline timeline notches removed.** The small coloured dots that
  used to paint directly on the timeline track were dropped at user
  request — only the avatar in the row below the timeline remains.
  Hover + click + touch behaviour on the avatar is unchanged.
- **Avatar row moved up.** The DR-style comment avatars now sit the
  same distance BELOW the white playhead as the yellow OUT handle
  sits ABOVE it (~18 px on mobile, ~23 px on desktop) — visually
  mirrored, so the playhead anchor reads as a clean horizontal
  three-point alignment.
- **Marker positions snap to frames.** Comment markers (and the
  seek target they fire on click) are now quantized to the
  nearest video frame using the clip's fps. Before, sub-frame
  `timestampMs` values produced an avatar at e.g. 4.123 s but a
  playhead at 4.0833 s after seek (24 fps frame boundary); now the
  two land on the same horizontal pixel.
- **Stacked-comment popover slides.** When the user swipes (or
  taps Prev/Next) through stacked comments at the same timestamp,
  the new card now slides in from the matching edge (next →
  right-edge, prev → left-edge) via custom CSS keyframes
  (`stack-slide-in-right` / `-left`) instead of the tailwindcss-
  animate fallback that was being silently dropped by
  `overflow:hidden` and backdrop-root quirks.
- **Cross-marker swipe navigation.** Horizontal swipe on the
  timeline-comment popover now walks across the ENTIRE timeline,
  not just the current stack — leaving the end of one marker's
  comments jumps to the first comment of the next marker (and
  vice versa), with the playhead seeking along.

### Fixed

- **Reply author label was wrong.** Admin-authored replies used to
  render as "Admin" because `submitInlineReply` didn't set
  `requestBody.authorName`, so the server stored `null` and the UI
  fell back to `User.name` (which is literally "Admin" in many
  installs). Replies now mirror `handleSubmitComment` and send
  `adminUser?.name || 'Admin'`, matching what the top-level
  comment shows for the same author.
- **White playhead jumped onto yellow ball after drag.** A
  long-standing race condition between `setCommentRange` and a
  legacy `videoTimeUpdated` listener (used to keep IN synced when
  frame-stepping a single-frame comment) was overwriting
  `selectedTimestamp` with the OUT time during the drag, because
  `onSeek(safeOut)` fires `videoTimeUpdated`. The listener now
  bails when `selectedTimecodeEnd !== null` (range OUT is set),
  preserving IN through the entire drag.
- **Drawing annotations failed while Rulers were on.** The
  RulersOverlay wrapper used the default `pointer-events: auto`,
  so it captured every click in the middle of the video and the
  AnnotationCanvas underneath never saw them. The wrapper is now
  `pointer-events-none` and only the ruler strips + guide
  hit-zones re-enable interactions.
- **Yellow OUT handle clipped into the timeline-comment popover.**
  The popover wrapper sat at `z-30` while the yellow handle was at
  `z-40`, so a marker near the start of the timeline (where the
  yellow ball lives) painted over the popover's avatar. Wrapper
  bumped to `z-50`.
- **Prev / Next showed for single-comment popovers.** The
  navigation buttons and "Tap or swipe to see other comments"
  hint used to appear whenever the timeline had more than one
  comment, even for a stack of one. They now only render when
  the current stack has 2+ comments — single-comment popovers
  read as clean info cards.
- **Re-focus on comment input cleared the range.** Clicking the
  textarea after dropping IN + OUT used to wipe `selectedTimecodeEnd`
  and re-capture IN at the live playhead, killing the selection
  the user had just made. The focus handler now bails if a range
  is already set, so re-focus is a no-op for users who already
  chose their window.
- **Mobile comment input drifted off the device bottom.** The
  "Leave your comment" composer on phones is now `position: fixed`
  pinned to the device bottom with safe-area inset padding, and
  the messages list above gets `padding-bottom` equal to the
  composer's measured height (tracked via `ResizeObserver`) so
  comments never disappear under the keyboard.

### Internal

- New `SafeZoneOverlay` and `RulersOverlay` components mounted
  inside `videoWrapperRef` (siblings of `AnnotationOverlay` /
  `AnnotationCanvas`). Both compute the painted video rect on
  every resize using a `ResizeObserver` so the overlays line up
  with the letterboxed / pillarboxed video frame regardless of
  wrapper aspect.
- New `PlayerSettingsMenu` component, rendered via `createPortal`
  to `document.body` to escape parent backdrop-root stacking so
  the menu's own `backdrop-filter: blur(20px)` paints correctly
  on iOS Safari (same pattern used for `PlayerTopMenu` and the
  timeline-comment popover).
- New `PlayerTopMenu` component (top-right kebab on the share
  page) with Copy share link / Delete current version (red,
  confirm-protected) / Copy & Paste comments / Switch theme.
  Also portal-rendered so its own blur is unaffected by parent
  backdrop-roots.
- New atomic `setCommentRange` event wired through
  `useCommentManagement` so IN + OUT are committed in a single
  React batch — eliminates the order-of-events race that broke
  the older two-event (`setCommentRange` → `setCommentOutPoint`)
  flow on slow renders.

## [1.3.2] - 2026-05-24

A small follow-up to 1.3.1 that brings the Frame.io-style timeline
comment popover to desktop and fixes a couple of hover ergonomics
issues spotted in real use.

### Changed

- **Unified popover design across breakpoints.** Desktop now uses
  the same translucent card (50 % `bg-card` + `backdrop-blur-sm` +
  yellow timestamp chip) as mobile instead of a separate compact
  black tooltip. The two surfaces now read as the same component
  at any width.
- **Prev/Next buttons are real buttons.** The stack-navigation
  controls inside the popover have a filled `bg-muted` background +
  `ring-border` outline + medium-weight label, so they read as
  clickable actions instead of dim text links.

### Fixed

- **Popover overflowed at the start / end of the timeline on
  desktop.** A marker at position < 20 % (or > 80 %) used to push
  half the 220 px tooltip off-screen because an inline
  `translateX(-50%)` overrode the alignment classes. The transform
  is gone, the alignment helper now emits `sm:left-0` / `sm:right-0`
  / `sm:left-1/2 sm:-translate-x-1/2`, and the card stays inside
  the viewport regardless of where the marker is.
- **Popover dismissed before the mouse could reach it.** There's an
  8 px gap between the avatar marker and the popover above it —
  crossing that gap used to fire `mouseleave` immediately and close
  the popover before the cursor landed on it. A 220 ms close-debounce
  on the hover state lets the cursor traverse the gap and re-enter
  the popover without losing it.

## [1.3.1] - 2026-05-24

A polish pass on top of 1.3.0's responsive work, focused on the
real-world phone experience after testing FrameComment on an actual
device. Touches almost every interactive surface — uploads, menus,
the timeline comment popover, the comment input — to make each one
feel native on small screens.

### Added

- **Mobile single-PATCH TUS upload path.** Mobile browsers (iOS
  Safari, Chrome on Android, Brave) would drop the XHR connection
  between TUS PATCH requests, stalling the upload after the first
  10 MB chunk. We now send the entire file in a single PATCH on
  phones for anything under 100 MB, which fully sidesteps the
  "between chunks" failure mode. Files above that still chunk at
  8 MB to avoid memory pressure.
- **Frame.io-style timeline comment popover.** Tapping a comment
  avatar on the timeline now opens a card centred on the viewport
  with a yellow timestamp chip, the full body text (no line-clamp,
  word-break safe), and a 50 % opaque background that lets you see
  the drawn annotations through the popover. When several comments
  share a timestamp, the card shows one at a time with a 1/N
  indicator and swipe navigation (← / → buttons on desktop). The
  popover stays open until you tap outside it — no auto-dismiss
  timer.
- **Smart-positioned kebab menus everywhere.** Video, folder, and
  project cards now compute the kebab's screen position when the
  menu opens and place the popover at the right offset so it never
  overflows the viewport — exactly how Frame.io behaves. Helper
  lives in `src/lib/popover-position.ts`.
- **`computePopoverStyle` helper.** Shared smart-positioning code
  with horizontal clamping and vertical flip ("open above when not
  enough room below") so the kebab popovers on the dashboard work
  the same as the ones inside folders.
- **`allowedDevOrigins` config.** Lets the dev server accept
  requests from LAN IPs (used for live phone testing). Dev-only —
  production builds are unaffected.

### Changed

- **Iconize the project folder top bar on phones.** Back, Upload,
  Download All, New Folder, and Project Settings collapse to
  icon-only buttons that all fit on one row at 360 px instead of
  stacking 2x2.
- **Trash row controls upgraded.** Delete (X) button now uses the
  outline-destructive style so it reads as a real action on phones
  instead of disappearing into the dark row. Empty Trash header
  button also picks up the destructive accent.
- **Comment input auto-grows.** The composer textarea now expands
  vertically with the user's typing, capped at 40 % of the
  viewport with internal scroll for very long messages. New
  `maxLength={6000}` matches the server-side validator.
- **Comment popover transparency.** Background at 50 % opacity
  with a subtle backdrop-blur so the annotations underneath stay
  visible without losing legibility on the text.
- **Avatar wrapper z-index.** Bumped to z-30 so the timeline
  popover paints above the annotation overlay (z-10) and the
  drawing canvas (z-20) — previously the SVG drawings could
  appear to cut through the popover surface.

### Fixed

- **iOS Safari auto-zoom on input focus.** All text inputs and
  textareas use 16 px font on mobile (`text-base sm:text-sm`) so
  iOS doesn't trigger its automatic zoom when the user focuses an
  input. Pinch-zoom for accessibility still works.
- **Layout shift on first paint on Android Chrome.** Added an
  explicit `<meta name="viewport">` as the very first `<head>`
  child plus `viewport-fit=cover` so the browser sees device-width
  before it starts laying anything out — fixes the "everything is
  zoomed in / clipped" first render.
- **Horizontal overflow on the Trash page.** Long file names
  pushed the Empty Trash / Delete buttons off the visible viewport
  edge on phones. The header and row containers now have
  `min-w-0 w-full` so the truncate utility actually shrinks them.
- **Smooth-scroll attribute.** Added `data-scroll-behavior="smooth"`
  on `<html>` so Next.js doesn't smooth-scroll the entire page when
  the user navigates between admin tabs.
- **`overflow-x: clip` on `<html>`.** A stronger guard than
  `overflow: hidden` on `<body>` for Android Chrome, which can
  still scroll the document element if any descendant breaks out.
- **No auto-scroll to comment on phones.** Tapping a dot on the
  timeline used to scroll the comment list into view, which threw
  the video off-screen on phones. We now seek + highlight without
  scrolling so the player stays visible — Frame.io style.

## [1.3.0] - 2026-05-23

A responsive pass across the entire admin surface. Every page the
admin sees on a 360-414px phone or a 768-1024px tablet has been
tightened up: titles shrink, action buttons collapse to icon-only
on phones, and content blocks gain `min-w-0` so they can actually
shrink in their flex containers.

### Changed

- **Admin dashboard (Projects).** Page header uses a proper flex
  layout (`min-w-0 flex-1` on the title block + `shrink-0` on the
  New Project button) so the title can truncate gracefully and the
  button never gets pushed off-screen at 360px. Title drops to
  `text-xl` on phones, the subtitle to `text-xs`, and the button
  becomes icon-only below sm:. Table view rows get tighter side
  padding on mobile (`px-3` instead of `px-5`) so the thumbnail +
  name + kebab all fit.
- **Project detail page (folder browser).** Back / New Folder /
  Project Settings buttons no longer claim `min-w-[150px]` on
  phones — they're proper `size="sm"` icon-only buttons below sm:
  and restore the desktop look from sm: up. All three fit on one
  row at 360px now (used to wrap awkwardly).
- **Folder browser grid.** Switched from `grid-cols-1` on mobile
  to `grid-cols-2`. A single-column layout was wasting screen
  space on phones — two cards per row reads much better and
  matches the Frame.io reference. Gap tightens from `gap-4` to
  `gap-3` on phones.
- **Empty state inside a folder.** Vertical padding drops from
  `py-20` to `py-10` on phones and the minimum height from 400px
  to 280px so the "drop files here" prompt doesn't dominate the
  screen on small viewports.
- **Trash page.** Header title shrinks + description truncates so
  the Empty Trash button stays visible. Empty Trash collapses to
  icon-only below sm:. Each Trash row gets tighter horizontal
  padding on phones, Restore button hides its label below sm:,
  and the per-level indent halves on phones (12px steps instead
  of 24px) so deeply nested items don't push the action controls
  off-screen.
- **Users + Settings pages.** Same header pattern as the dashboard:
  title block gets `min-w-0 flex-1`, icon shrinks to `w-6 h-6`,
  primary action button (Add User / Save) becomes icon-only on
  phones. Settings page's existing mobile-stacked layout (vs.
  desktop sidebar) was already in place — this release just
  polishes the title row.

### Notes

- The share page (the public viewer clients see) was already
  rebuilt for mobile in 1.0.4 (stacked player + comments,
  resizable sidebar from lg+, mobile-collapsible comment panel).
  This release leaves that work in place.
- Login / Setup pages already used a centered `max-w-md` card so
  they were mobile-friendly out of the box — no change needed.

## [1.2.1] - 2026-05-22

A small polish release focused on the Trash workflow.

### Added

- **Trash count badge on the admin nav.** A compact red pill sits
  over the Trash icon in the admin header whenever there are
  recoverable items. The count refreshes automatically on tab focus
  and after every delete / restore / empty-Trash action so it
  always reflects the live state without needing a manual reload.
  Backed by a new lightweight `GET /api/trash/count` endpoint that
  only returns the number (no thumbnails, no signed tokens) so the
  header stays cheap to render.
- **Empty containers skip Trash entirely.** Deleting a folder that
  holds no videos in its entire subtree — or a project with no
  folders and no videos — now hard-deletes right away instead of
  parking an empty shell in Trash for 30 days. Trash stays focused
  on items that actually carry recoverable work.
- **No confirm dialog on empty deletes.** The "Move to Trash"
  confirmation now skips itself when the folder or project being
  deleted is empty. There's nothing to lose, so the prompt would
  just be friction — clicking Delete on an empty container removes
  it in one tap.

### Fixed

- **"Delete permanently" on a project from Trash.** The Trash page
  used to fall through to the video DELETE path for projects,
  silently 404 on a missing video id, and leave the project stuck
  in Trash. Projects now route to their own DELETE endpoint with
  `?permanent=1`, which calls the same teardown helper the cleanup
  cron uses.

## [1.2.0] - 2026-05-20

### Added

- **Frame.io-style "Mark as done" on every comment.** A new check
  icon appears in the hover cluster on each comment — clicking it
  flips the comment to resolved (and clicking again unflips). When
  resolved, the small `#N` indicator in the top-right of the
  comment is replaced by a green ✓ badge and the whole comment
  body dims so reviewers can focus on what's still actionable.
  Backed by three new columns on `Comment` (`isResolved`,
  `resolvedAt`, `resolvedBy`); any viewer with comment permission
  can toggle, mirroring Frame.io's collaborative workflow.
- **Emoji reactions on comments.** Hover a comment to reveal the
  emoji button, pick one from the in-app picker, and it lands as
  a pill under the comment grouped by emoji with a per-emoji
  count. Tapping a pill again removes your reaction (idempotent
  on (comment, viewer, emoji)). Backed by a new `CommentReaction`
  table with a unique constraint per viewer + emoji + comment, so
  duplicate clicks don't fan out into multiple rows.
- **Editable display name for guests.** A name field under the
  "Feedback & Discussion" header lets a reviewer replace their
  auto-assigned "Client N" label with their real name. The
  rename endpoint bulk-updates every existing comment owned by
  that viewer, so the change is retroactive across the whole
  share link. Persists to localStorage, predicts the next
  available "Client N" before the viewer posts, and pushes
  through to new comments without a flash of the wrong name.
- **Single-video share links.** Admin "Copy link" on one video now
  produces an HMAC-signed URL (`?v={name}&sig={hmac}`). The share
  GET endpoint validates the signature and serves only that video
  — no neighbouring videos in the thumbnail reel, no comments
  from other videos. Tampering with the URL breaks the
  signature so clients can't widen scope. No DB / migration
  required.
- **Live playhead + always-on timestamp chip in the comment input.**
  The chip displays the playhead position in real time before the
  user even focuses the input (driven by a throttled
  `videoTimeUpdated` event), freezes on the captured IN point
  once they click in, and clears back to the live playhead when
  the chip's X is pressed.
- **Shimmer placeholder animation** sweeps across the "Leave your
  comment…" text via a 3.6s gradient + `background-clip: text`,
  reinforcing that the input is interactive.
- **Upload date under the player title** shows the active version's
  creation time (`12-05-2026 23:05 (7 Days ago)`), so reviewers
  can tell at a glance how long passed between v1 / v2 / v3 just
  by switching versions.
- **Project cover images.** Optional upload at New Project time
  (or via a future Settings field) replaces the deterministic
  gradient on the dashboard card. Stored under
  `projects/{id}/cover.{ext}` via the existing storage abstraction
  and served by a new admin-only endpoint
  (`GET /api/projects/[id]/cover`). Frontend pulls the image
  through `apiFetch` + `URL.createObjectURL` so the bearer token
  is honoured even though it's an `<img>` source.
- **Soft-deleted projects + 30-day Trash.** `DELETE /api/projects/[id]`
  no longer hard-deletes — it stamps `Project.deletedAt`, kicks
  every share session, and hides the project from listings + the
  share endpoint (clients get 404 immediately). The Trash page
  now lists projects alongside videos and folders, with Restore
  bringing the whole subtree back instantly. The daily cleanup
  cron permanently removes projects (and their files) once
  `deletedAt` is older than 30 days, mirroring the existing
  video/folder pattern.
- **Frame.io-style New Project modal.**
  - Single-card composer with a big square preview area on top.
    Whole tile is the file picker — drop or click anywhere to
    upload a cover image. A centered `ImagePlus` icon hints at
    the affordance when empty; a remove button shows when a
    cover is attached.
  - Title input pinned inline at the bottom of the preview,
    over a subtle dark fade so it stays readable on any image.
  - "Make Restricted" toggle replaces the legacy
    authentication checkbox + password field. Server
    auto-generates a strong password when the toggle is on;
    admins view/rotate it later from Project Settings.
  - Lock chip in the corner mirrors the toggle with a
    `LockOpen` ↔ `Lock` swap animation.
  - Enter submits the form, no `+` icon on the Create button,
    `Untitled Project` placeholder follows Frame.io.
- **Modern in-app confirm dialog.** Replaces the native
  `window.confirm()` for destructive actions (Delete / Archive
  project). Themed Radix Dialog with a warning icon, descriptive
  copy, and a busy spinner while the action runs.

### Changed

- **MessageBubble redesign — closer to Frame.io.** The timecode
  badge now sits inline at the start of the comment body (so a
  one-line reply reads as one line, not three), the action row
  shows only "Reply" by default, and the rest of the cluster
  (emoji react / kebab / mark as done) only appears on hover so
  the comment list stays quiet. The kebab dropdown is now the
  single source of truth for Edit + Delete — the old inline
  pencil / trash icons are gone, and "Copy Link" is no longer
  surfaced as a per-comment action.
- **Comment input layout** is now a single Frame.io-style row:
  no separate textarea card, transparent background, timestamp
  inline with the placeholder/text, action row tucked
  underneath. Inline icons (annotation, attachment, mic, emoji)
  share one borderless style so the strip reads as one unit.
- **MM:SS everywhere** for comment timestamps. `formatCommentTimestamp`
  now ignores the `TIMECODE`/`AUTO` setting and always emits
  clock format (MM:SS, or HH:MM:SS for clips ≥ 1 hour) — the
  frames component was just noise next to the per-second
  granularity of the live playhead.
- **Trim leading `00:` segments** from every other timecode
  display too (player time, range chip, badges).
- **Muted gradient palette** for the project tiles. Saturation
  pinned to 18–28% and lightness to 12–19% so the dashboard
  reads as a quiet family of dark tiles instead of a wall of
  primary colours. Two distinct projects still get visibly
  different tints; nothing looks neon.
- **Hover-zoom dropped on project tiles** — only the ring
  highlight remains, the cover/gradient itself stays still.
- **`+ New Project` tile + empty state CTA** open the new modal
  directly instead of navigating to the legacy `/admin/projects/new`
  page.

### Fixed

- **Range selection only via the orange handle.** Clicking the
  timeline ahead of the IN point used to silently set the
  comment's OUT (and the scrub drag did the same), making it
  impossible to seek inside the marked range without clobbering
  it. Range now only moves when the user drags the dedicated
  orange handle above the timeline.
- **Re-focusing the comment input re-syncs the IN point** to the
  current playhead, so adjusting the starting frame is just a
  matter of scrubbing and re-clicking the input.
- **Edit / Delete now appear on the guest's own comments.** The
  ownership check used `clientSessionId` (share-token id) but
  comments store `client:<browserId>` since 1.0.7+; the new
  helper accepts both, matching the server-side authorization
  that already worked.
- **New comments use the chosen guest name + instant rename.**
  Posting now carries the editable name to the server; renaming
  optimistically patches every existing row of the viewer in the
  same listing so the change is visible the instant Enter is
  pressed instead of flickering once the network reply lands.
- **Project cover endpoint** is admin-gated; the frontend fetches
  it through `apiFetch` + blob URL so the bearer token is
  honoured. Cards never flash the wrong-colour gradient before
  the cover loads — we render a neutral `bg-muted` underneath
  instead, and the gradient outline that bled out at hover is
  gone.
- **Single-video share — client-side fetches forward the signed
  params.** The share page used to scope correctly only on the
  initial SSR-style fetch; subsequent client refreshes pulled
  the whole project. Both `loadProject` and `fetchComments`
  now thread `v` + `sig` from `window.location.search`.
- **i18n keys** added for the new comment actions
  (`addReaction`, `moreActions`, `markResolved`,
  `markUnresolved`, `resolved`) so `next-intl` no longer throws
  `MISSING_MESSAGE` on the redesigned hover cluster.

## [1.1.1] - 2026-05-14

### Fixed

- **macOS emoji picker (Ctrl+Cmd+Space) now opens AND inserts**
  while writing a comment in the player. Two stacked bugs:
  1. The player's global keyboard shortcut for play/pause checked
     `e.ctrlKey && e.code === 'Space'` without excluding `metaKey`,
     so Ctrl+Cmd+Space matched the play/pause branch and
     `preventDefault()` killed the OS shortcut before macOS could
     even open the picker. Every Ctrl-based shortcut in both
     `VideoPlayer` and `VideoComparison` (Ctrl+Space, Ctrl+, / `<`,
     Ctrl+. / `>`, Ctrl+/, Ctrl+J, Ctrl+L) now also requires
     `!e.metaKey`, so any Cmd-augmented combo falls through to the
     OS.
  2. Even with the picker open, clicking an emoji did nothing.
     After instrumenting the textarea with every plausible event
     listener (`input`, `beforeinput`, `composition*`, `keydown`,
     `keypress`, `paste`) we confirmed that **Chrome on macOS
     Sequoia fires zero events for the system Apple Intelligence
     emoji picker** — the OS believes it inserted but no event
     ever reaches the page. Slack / Discord / Frame.io all ship
     their own picker for this reason, so we did the same.

### Changed

- **Re-focusing the comment input re-syncs the IN point.** If you
  clicked the textarea, then scrubbed the timeline to a different
  position, then clicked the textarea again, the IN marker used to
  stay at its original spot. Now it follows the playhead on every
  focus, so you can keep adjusting your starting frame just by
  re-clicking the input. Any user-defined OUT is dropped since a
  range anchored to a now-stale IN is more confusing than useful.
- **Comment range is now set ONLY by dragging the orange handle.**
  Clicking the timeline ahead of the IN point used to silently set
  the comment's OUT point (and the playhead-scrub drag did the
  same), which made it impossible to seek inside the marked range
  without accidentally clobbering it. Now those gestures just
  scrub like normal — the OUT only moves when you drag the
  dedicated orange handle above the bar.
- **Trim leading `00:` segments from every timecode display.**
  Short clips no longer waste pixels on the unused hours/minutes
  fields: a 4-second-23-frame timestamp now reads `04:23` instead
  of `00:00:04:23`, and a 1m23s clip reads `01:23:04`. The trim
  applies everywhere the timecode is rendered — comment badges,
  the range chip above the comment input, and the player time
  display below the video. Hours stay visible when the clip is
  actually an hour or longer.

### Added

- **In-app emoji picker.** A new smile-icon button sits next to
  the paperclip / mic icons under the comment input. Clicking it
  opens a Frame.io-style popover (floating via `position: fixed`
  so it doesn't push the sidebar around) with:
  - A **"Recently used"** row right under the search — picks are
    persisted in `localStorage` and survive reloads, so the
    emojis you actually use are always one click away.
  - Categorised emojis (Smileys, People & gestures incl. 🙏,
    Hearts, Work & video, Reactions) plus a search box.
  - Selecting an emoji inserts it at the current caret position
    via the textarea ref and restores focus + cursor.
  - ~500 hand-picked emojis shipped inline. No external deps.
- The native `input` / `compositionend` listener added in the
  previous fix attempt is kept in place — it's a no-op for the
  Sequoia picker (no events fire) but still useful insurance for
  legitimate IME inputs that might bypass React's `onChange`.

## [1.1.0] - 2026-05-14

In progress.

### Changed

- Clicking empty space in the folder grid now clears the current
  multi-select (Finder / Frame.io semantics). Clicks on a video
  card, a folder card, the floating selection toolbar, or any
  menu / dialog surface are excluded — only a click on genuinely
  empty grid space drops the selection.
- The **Upload Video(s)** button on the folder page top bar is
  now the solid primary-blue style (`variant=default`) instead of
  the neutral outline. It's the page's primary action, so it
  earns the emphasis; the other three (Download All / New Folder
  / Project settings) stay outline.
- The **video card footer** (the title + meta strip below the
  thumbnail) now has an explicit light-gray background
  (`bg-zinc-200 dark:bg-zinc-800`) instead of inheriting the
  card's base colour, so video cards read as clearly distinct
  from folder cards in the same grid. Uses concrete zinc shades
  rather than the (very subtle) `muted` token so the contrast
  is obvious in both light and dark mode.

### Changed — Action menu reorder + Duplicate

- Every action menu (right-click context menu, video kebab, folder
  kebab) is now organised into 4 visually-separated sections:
  1. **Download · Share**
  2. **Duplicate · Rename** (+ Split versions on video cards with
     more than one version)
  3. **Move up one folder · New Folder with selection**
  4. **Delete**
- New **Duplicate** action everywhere — creates a real file-level
  copy of every selected video and/or folder in the **current
  folder** with a `(1)`, `(2)`, … suffix appended to the name.
  Implemented via a new admin endpoint
  `POST /api/items/duplicate` that:
  - For each video group, copies the underlying storage file
    (via `downloadFile` → `uploadFile` streaming) for every
    version, creates new Video records with status=PROCESSING,
    and enqueues the worker to regenerate thumbnail / preview /
    storyboard from the freshly-copied original.
  - For image assets, marks the new record READY immediately and
    reuses the new original as its own thumbnail (no worker step).
  - For folders, walks the subtree depth-first and mirrors the
    structure under a freshly-minted parent folder.
- Share and Rename hide automatically at ≥ 2 selected (they
  don't make sense across a multi-select). Single-target sections
  collapse their separator when nothing renders, so the menu
  doesn't show empty dividers.

### Added — Multi-select on folder cards

- Folder cards now participate in the same Frame.io-style multi-
  select as videos. Each folder card gets:
  - A top-left checkbox (visible on hover or always when the
    selection is active), a primary ring when selected, and a
    click-to-toggle interaction in selection mode (clicking the
    card no longer drills into the folder while any items are
    selected — it toggles selection instead, mirroring VideoCard).
  - A bulk-aware kebab: at ≥ 1 selected, **New Folder with
    selection** and **Download** appear (the download path
    descends recursively into selected folders and gathers every
    video). At ≥ 2 selected, **Rename** and **Share** hide, and
    **Move up** / **Delete** swap to count-aware labels
    ("Move 3 up one folder", "Delete 3 items").
  - Right-click on a folder card auto-selects it (Finder
    semantics) and opens the context menu with the combined
    bulk actions.
- A new `selectedFolderIds` state runs in parallel with the
  existing `selectedVideoIds`. All bulk handlers
  (`handleDelete`, `handleMoveFolderUp`, `handleMoveVideoUp`,
  `handleNewFolderWithSelection`, `handleBulkDelete`,
  `handleBulkDownload`, `handleMoveVideoToFolder`,
  `handleDropOnFolder`) now branch on the **combined** count
  (`totalSelected = selectedVideoIds.size +
  selectedFolderIds.size`) so a mixed selection (videos AND
  folders) is treated as one batch.
- Bulk drag-and-drop crosses kinds: dragging a *selected* folder
  card onto a target folder moves every selected folder + every
  selected video group into the target in one pass. Same for
  dragging a *selected* video card. Dragging an unselected card
  still moves only that one (Finder semantics — selection stays
  untouched).
- "New Folder with selection" wraps mixed selections: the new
  folder ends up containing every previously-selected folder AND
  every previously-selected video group.
- "Download" recurses through selected folders client-side via
  the existing `/api/folders/[id]` endpoint, collecting the
  latest version of every video under the subtree, then triggers
  sequential browser downloads.
- The floating selection toolbar now reports the **combined**
  count ("3 items selected") instead of video-only ("3 videos
  selected").

## [1.0.10] - 2026-05-14

A polish + bug-fix follow-up to 1.0.9. Unifies the "Back" buttons
and top action bars across the project, folder, and player pages;
drops the redundant Shortcuts button; and fixes a handful of
image-asset and navigation bugs that surfaced once 1.0.9 was in use.

### Changed — Unified "Back" + top action bars

- The "Back to project" / "Back to Projects" buttons (folder page
  AND project root page) now use the unified neutral outline style
  + `min-w-[150px]`, and both just read **"Back"** with the arrow
  icon. They stay on the left, separated from the action group by
  the row's `justify-between`.
- The **project root page** top bar got the same treatment as the
  folder page: "New Folder" is hoisted out of the FolderBrowser
  breadcrumb row up alongside "Project settings". FolderBrowser is
  mounted with `hideHeaderActions` there too, driven through its
  imperative ref.
- In the video player header, the "All Videos" button (grid glyph)
  is now a plain **"Back"** arrow button too. The `backLabel`
  override — e.g. folder-share's "Back to folder" — still takes
  precedence when set.

### Added

- Right-clicking a video card now **auto-selects** it (Finder
  semantics): right-clicking a card that isn't part of the current
  selection replaces the selection with just that card, so the
  context menu instantly exposes Download / Move up / New Folder /
  Delete for it without ticking the checkbox first. Right-clicking
  a card that's already selected leaves the multi-select untouched.

### Removed

- The **"Shortcuts" button** is gone from the comment input area
  (both the normal and comments-disabled states). The keyboard
  hint ("press Enter to send") stays on wide sidebars; the
  shortcuts overlay was redundant.

### Fixed

- **Clicking a comment on an image no longer refreshes the page.**
  Image comments have no timeline, but clicking one still ran the
  seek path — and `handleSeekToTimestamp`'s "no `<video>` element"
  fallback (an image renders as `<img>`) did a full-page
  `window.location` navigation. Now: image assets short-circuit
  the seek entirely, image comments never render a timecode badge
  and don't seek on click, and newly-created image comments don't
  store a `timestampMs` at all.
- **Attachment + voice-recorder buttons now show in the admin
  comment box.** They were gated behind `allowClientAssetUpload`,
  which the admin share page never passed — so the paperclip and
  mic buttons silently never rendered for the admin. The admin
  share page now passes it explicitly: attaching files and
  recording audio is an admin capability, independent of the
  client-facing upload toggle.
- **Player "Back" button now returns to where you came from.**
  Previously, clicking "Back" while watching a video always dropped
  you on the in-page "Select a video" grid — which looks like the
  client-facing share view and isn't where an admin started. Now
  the player tracks how it was reached: if you opened the video by
  clicking a card on the admin folder / project page, "Back" leaves
  the share route entirely and returns to **that folder** (or the
  project root when there's no folder context). The in-page grid
  is still the "Back" target only when you genuinely picked the
  video from that grid. Everything stays on the admin side — it
  never bounces you out to the client view.
- The admin share/grid "Back to Project" button also reads the
  `folderId` from the share URL, so it returns to the originating
  folder instead of always jumping to the project root.

## [1.0.9] - 2026-05-14

The "bulk hygiene" release. The video kebab now understands the
selection, single-target actions disappear when they don't make
sense across a multi-select, and a brand-new **New Folder with
Selection** action turns a pile of selected clips into a tidy
folder in one click — with the name already in edit mode so you
can type the real name immediately.

### Added — Multi-select aware kebab

- Selecting 2+ videos and clicking **Delete** or **Move up one
  folder** from *any* card's kebab now applies the action to the
  whole selection, not just the card the kebab was opened on. The
  button labels swap to read "Delete N videos" / "Move N up one
  folder" so it's obvious you're acting on the selection.
- Selecting 2+ videos *hides* **Rename**, **Share video**, and
  **Split versions** from the kebab — those don't make sense
  across a selection.
- New **New Folder with Selection** kebab item. Shows up as soon
  as at least one video is selected. It:
  1. Creates a folder named `New Folder` (with a `(2)`, `(3)`
     suffix when there's already a sibling with that name) at the
     current location.
  2. Batch-moves every selected video's entire version group into
     it via the existing `PATCH /api/videos/batch` endpoint, so
     the move stays atomic.
  3. Mounts the brand-new folder card in **inline auto-rename
     mode** — the title swaps for an `<input>` with the placeholder
     name already focused and selected, exactly like Frame.io. Hit
     Enter or click away to commit; Escape reverts.

### Added — Bulk drag-drop into folder

- Dragging a card that's *part of* a selection of 2+ onto a folder
  now moves the **entire selection** in one batch call. Finder /
  Frame.io semantics: dragging a card that *isn't* in the
  selection still moves only that card, leaving your selection
  untouched.
- While a selected card is being dragged, every other selected
  sibling renders ghosted so it's obvious the whole batch is
  travelling together. Non-selected cards stay un-ghosted and
  available as stack-onto targets where the previous behaviour
  allowed it.
- The mouse cursor now carries a Frame.io-style **stacked
  preview** during a bulk drag: up to three thumbnails layered
  at slight rotational offsets with a blue count badge ("3") in
  the corner — so it's immediately clear how many videos are in
  flight. Built via a hidden DOM element passed to
  `dataTransfer.setDragImage` and torn down on the next tick.
- Re-enabled the HTML5 drag handle on video cards in selection
  mode. In 1.0.6 we'd intentionally disabled dragging once any
  card was selected to keep click-to-toggle behaviour predictable;
  with bulk drag-to-folder now in scope that guard had to come
  off. The HTML5 DnD API still distinguishes click from drag by
  mouse-move threshold, so single-click toggling continues to work
  as before.

### Added — Image asset support (MVP)

- Image uploads are now first-class citizens of FrameComment. JPG,
  PNG, WebP, and GIF files travel through the same upload pipeline
  as videos and appear in the same Frame.io-style grid. The file
  pickers + drag-and-drop drop zones accept the new extensions
  automatically.
- New `MediaType` enum (`VIDEO` | `IMAGE`) on the `Video` model
  (migration `20260514120000_add_media_type`) — defaults to `VIDEO`
  so every existing row is unchanged. The upload route detects the
  media kind from the request MIME (with a filename-extension
  fallback) and stamps the new column.
- The TUS upload-finish handler short-circuits for image uploads:
  no worker queue, no FFmpeg, no storyboard. The original image
  doubles as its own thumbnail (`thumbnailPath = originalStoragePath`)
  and the row jumps straight from UPLOADING to READY.
- Image cards in the grid swap the empty-state Film icon for a
  Photo icon, hide the duration badge and version badge, and skip
  hover-scrub entirely. The Frame.io thumbnail layout (cover image
  + comment count + selection checkbox + kebab) stays unchanged so
  videos and images read as a single grid.
- The player renders a plain `<img>` for image assets — no `<video>`
  element, no playback controls, no timeline below. Comments still
  work as text-only against the asset; annotations / timeline pins
  are intentionally out of scope for the MVP and will come later if
  needed.
- Re-uses every Frame.io-style affordance you already have: drag
  into folders, drag-to-stack, multi-select, bulk delete / move /
  download, trash, restore. None of those needed code changes.

### Changed — Unified top action bar (folder page)

- On a folder page, **Upload Videos**, **Download All**, **New
  Folder**, and **Project settings** now sit on a single row at
  the top of the page, all sized to `min-w-[150px]` so they read
  as one cohesive bar.
- All four buttons share the neutral outline style; the icon is
  the differentiator, not the colour. (A first pass tried distinct
  colours per action — blue/green/yellow/neutral — but the row read
  too noisy.)
- `FolderBrowser` gained a `hideHeaderActions` prop and a `ref`
  with an imperative handle (`openNewFolderDialog`, `downloadAll`).
  The folder page hides the inline buttons and drives the dialog +
  download flow via the ref, so there's no duplicated UI. The
  project root page is untouched — its `FolderBrowser` continues
  to render the inline buttons next to the breadcrumb.

### Added — Bulk actions in the right-click menu

- The right-click context menu now mirrors the video kebab when
  there's a multi-select active: **Move N up one folder**, **New
  Folder with N videos**, **Download N videos**, and **Delete N
  videos** show up at the top of the menu, above the usual Upload
  / New Folder block. Right-click and kebab are now at parity —
  pick whichever gesture you prefer.
- Both menus widened and switched to `whitespace-nowrap` so bulk
  labels ("Move 3 up one folder", "New Folder with 3 videos")
  sit on a single line instead of wrapping to two.

### Added — Inline rename on folder cards

- `FolderCard` gained `autoEditOnMount`, `onRenameCommit`, and
  `onAutoEditDone` props (1.0.9+). When `autoEditOnMount` is true
  the card mounts with the input focused + select-all'd. Commits
  PATCH `/api/folders/[id]` and clears the pending-edit flag on
  the parent so a sibling refresh doesn't retrigger the editor.
- While the input is focused, clicking the card no longer drills
  into the folder and drag is disabled so you can select text
  inside the input freely.

### Changed

- `VideoCard` accepts a new `bulkSelectionCount` prop. The kebab
  reads this number to decide which actions to show, which to
  rename ("Delete" → "Delete N videos"), and whether to surface
  the new folder action.
- `FolderBrowser.handleDeleteVideo` and `handleMoveVideoUp` now
  branch on `selectedVideoIds.size`: ≥ 2 routes through a bulk
  path that iterates the selection and refreshes once at the end;
  the single-card behaviour for 0–1 selected is unchanged.

### Notes

- No schema changes — every server-side route used by this
  release (`/api/folders` POST, `/api/videos/batch` PATCH,
  `/api/folders/[id]` PATCH, `/api/videos/[id]` DELETE) was
  already present in 1.0.8.
- The bulk semantics treat the *selection* as the source of
  truth. Clicking Delete from a card that isn't part of the
  selection still deletes the selection (not the clicked card)
  when 2+ are selected — this matches how Frame.io behaves and
  avoids accidentally adding/removing items from the selection
  through the kebab.

## [1.0.8] - 2026-05-14

The "safety net" release. Deleting an asset now drops it into a
30-day Trash, every confirmation prompt is a real modal, and the
ancient watermark feature is gone for good.

### Added — Trash (30-day soft delete)

- New `deletedAt: DateTime?` column on `Video` and `Folder` (migration
  `20260513120000_add_soft_delete`). Indexed so the cleanup query
  stays fast on large libraries.
- DELETE endpoints become soft-deletes by default. Pass
  `?permanent=1` to skip the bucket entirely (used by the Trash UI's
  Delete-permanently action and the cron). Folder soft-delete
  cascades to every descendant folder + every video inside the
  subtree so the whole subtree lands in Trash atomically.
- New routes:
  - `GET /api/trash` — every soft-deleted folder + video across the
    admin's scope, grouped by version, with thumbnails, parent
    location, `deletedAt`, and a precomputed `expiresAt`.
  - `POST /api/trash/{kind}/{id}/restore` — un-trash a folder or
    video group. When the original parent folder is itself in Trash,
    the item is re-parented to the project root so the user actually
    sees it after restore.
  - `POST /api/trash/empty` — permanently delete every soft-deleted
    item now.
- `src/lib/trash-cleanup.ts` centralises the hard-delete logic
  (storage file cleanup + DB row removal) and exposes
  `purgeExpiredTrash()` so the Empty Trash button and the cron share
  the same path.
- Worker cron (1.0.8+) — daily `setInterval` calling
  `purgeExpiredTrash()` to remove anything older than 30 days. Runs
  once at worker startup so a server that's been off for days
  catches up on first boot.
- New admin page at `/admin/trash` — Frame.io-style **collapsible
  tree** grouped by project. When a folder is trashed, every cascaded
  child (sub-folders + videos) nests inside it instead of cluttering
  the top level. Click the chevron to expand / collapse; arbitrary
  nesting depth is preserved. Each row has Restore + Delete-
  permanently buttons; "Empty Trash" in the header nukes everything.
- Top-bar nav adds **Trash** between Projects and Users so admins
  can reach it from any page.
- Every folder/video listing endpoint now filters `deletedAt: null`
  so trashed items never leak into the grids, share pages, mosaic
  previews, or item counts.

### Added — Split versions

- New **"Split versions"** action in the VideoCard kebab (1.0.8+).
  Surfaces only when the group has more than one version. Opens a
  Frame.io-style modal listing every version (thumbnail + label +
  filename + date) with checkboxes; picking one or more extracts
  them back out into standalone cards.
- New endpoint `POST /api/videos/split` performs the rename atomically:
  each extracted row gets a fresh group `name` derived from its
  `originalFileName` (extension stripped), with `" (2)"`, `" (3)"`
  suffixes to dodge collisions. Then it renumbers the donor group
  so the remaining versions stay `v1..vN` contiguous in `createdAt`
  order.
- Undoes accidental drag-to-stack: drop the wrong version onto a
  group? Split it back out without re-uploading.

### Added — Frame.io-style confirmation + share modals

- `ConfirmModal` (`src/components/ConfirmModal.tsx`) — generic
  confirmation dialog built on top of the existing Radix Dialog.
  `default` and `destructive` variants, optional spinner during
  long-running confirms.
- `ShareModal` (`src/components/ShareModal.tsx`) — Frame.io-clone
  share dialog. Big read-only link field with a `Copy` button that
  briefly flips to a green check, plus an explanatory caption.
  Falls back to `window.prompt` when the clipboard API is blocked.
- All in-app destructive flows now route through `ConfirmModal`
  instead of the OS `window.confirm`:
  - Delete on a video card (single + bulk in selection mode)
  - Delete on a folder card
  - Empty Trash + Delete-permanently in the Trash page
- All share flows now route through `ShareModal` instead of
  `alert("Link copied")`:
  - Share video (kebab on VideoCard)
  - Share folder (kebab on FolderCard)

### Fixed

- Grids refresh instantly after Delete / Restore / Move /
  drag-onto-folder / drag-to-stack / Split. Previously the user had
  to reload the page because the FolderBrowser was only being told
  to refresh by the parent (which in turn re-fetched a different
  endpoint than the one feeding `rootVideos`). All mutation handlers
  now call BOTH `fetchFolders()` (local refresh) and `onMutated()`
  (parent refresh) so it doesn't matter which surface is feeding the
  grid.
- The loading spinner on FolderBrowser no longer flashes after every
  mutation. `fetchFolders` accepts `{ silent: true }` to skip
  `setLoading(true)` on background refreshes; the parent folder
  page passes `silent: true` to its own `fetchFolder` when called via
  `onMutated`. Initial mounts and manual reloads still show the
  spinner.
- "Delete permanently" in Trash now wipes every version of a video
  group, not just the latest. `TrashItem.allIds` is wired through
  the page and the handler iterates the full list, then the row
  group disappears from the listing.

### Removed

- Watermark feature is gone. `getProcessingSettings` always returns
  `watermarkText: undefined`, so the FFmpeg drawtext filter is
  never applied. The legacy `Project.watermarkEnabled` /
  `watermarkText` / `watermarkPositions` / `watermarkOpacity` /
  `watermarkFontSize` columns stay in the schema for backward
  compatibility but are no longer consulted.

## [1.0.7] - 2026-05-13

The "Frame.io polish" release. Folders learn to upload whole trees,
cards grow real mosaic covers, anonymous reviewers stop collapsing
into a single "Client", and the admin player stays admin even when
its parent folder is shared.

### Added — Whole-folder drag-and-drop upload

- Drop an OS folder onto a project or sub-folder and FrameComment
  walks the tree via `webkitGetAsEntry`, filters to video extensions
  (mp4, mov, mkv, webm, avi, m4v, mxf, prores; hidden files like
  `.DS_Store` get dropped), and recreates the hierarchy as
  FrameComment folders before uploading each video into its matching
  destination. The "Upload Folder" picker in the empty-state dropdown
  also routes through the same path via `webkitdirectory`.
- `src/lib/folder-upload.ts` — `snapshotDataTransferEntries`,
  `walkSnapshotEntries`, `uniqueDirectoryPaths`,
  `createFolderHierarchy`, plus a shared video-extension whitelist.
  Snapshots happen synchronously in the drop handler because
  `DataTransferItem` references are invalidated as soon as the
  handler returns.
- `VideoUploadModal` learns `initialFilesWithFolders` so each pending
  upload remembers its own `folderId` override for the
  `POST /api/videos` call. `AdminVideoManager` exposes a new
  `triggerUploadWithFolderTree` imperative method.
- A global `framecomment:folders-changed` event makes the
  FolderBrowser refetch its sub-folder list immediately after a
  programmatic create, so the new folders appear in the grid without
  a manual refresh.

### Added — Frame.io-style folder cards

- Folder cards now render a full-width mosaic cover (`aspect-video`)
  instead of a small icon in the corner. The cover shows up to 4
  preview tiles arranged the same way Frame.io does:
  - 1 item → one full tile
  - 2 items → split 50/50 vertical
  - 3 items → 1 big left + 2 stacked right
  - 4 items → 2×2 grid
  Tiles are separated by a 4px gap that picks up the card background
  so the slices read as deliberate Frame.io seams.
- Item composition mixes sub-folder glyphs and video thumbnails:
  sub-folders take priority (up to 4), remaining slots fill with the
  most recent READY videos. So `1 sub-folder + 6 videos` reads as
  `[folder, v1, v2, v3]`; `0 sub-folders + 3 videos` reads as the
  3-cell mosaic.
- New `src/lib/folder-previews.ts` (`fetchFolderPreviewData`) fetches
  preview tiles + corrected item counts in a single round trip for
  every folder. The "N items" label now counts *video groups* (one
  per distinct `name`), not raw rows — so a folder holding
  `1 sub-folder + 1 video with 3 versions` reads as "2 items", not 4.
- Both `/api/folders` (root) and `/api/folders/[id]` (sub-folders)
  emit `previewItems` + `itemCount`. The public folder share at
  `/share/folder/[slug]` now reuses the same FolderCard component
  (kebab hidden for clients) so reviewers see the same large mosaic
  as admins.

### Added — Numbered guest reviewers + deterministic colours

- `Client 1` / `Client 2` / `Client N` labels for anonymous viewers
  on a share link, indexed in first-comment-time order across the
  whole project. Implemented via `buildGuestSessionIndex` in
  `comment-sanitization.ts`, applied in:
  - `GET /api/share/[token]/comments`
  - `POST /api/comments` (both the listing GET and the create
    response, so the UI doesn't flash back to plain "Client" after
    each new post)
  - `GET /api/projects/[id]` (admin view)
- Per-tab `framecomment.clientId` UUID in `sessionStorage` (not
  `localStorage` — Chrome incognito windows share a private
  `localStorage` jar). The browser sends it as
  `X-Framecomment-Client-Id` on every POST/PATCH/DELETE to
  `/api/comments`, and the server uses it as the authoritative
  `editorSessionId` (`client:<uuid>`) so two anonymous viewers on
  the same public IP stay distinguishable. Edit/delete authorization
  accepts both the new `client:<uuid>` and legacy `none:<ip>` forms
  for backward compatibility.
- `getUserColor` now snaps "Client N" labels to a deterministic slot
  in the receiver palette (`RECEIVER_PALETTE[(n-1) % 20]`), so Client
  3 is the same colour on every browser regardless of registry load
  order. Used by sidebar avatars, timeline marker dots, and tooltips.

### Added — Smaller, opaque timeline markers

- Comment dots on the timeline are now solid-filled circles (saturated
  500-tier fills, white initials, thin `ring-black/40` outline) instead
  of translucent pastel bubbles. Sized down to `w-4 h-4 sm:w-[18px]
  sm:h-[18px]` to match Frame.io. The mini-avatars in the marker
  tooltip get the same solid treatment.

### Added — Move-up, drag-into-folder, share-this-video

- "Move up one folder" menu item on both VideoCard and FolderCard.
  Videos / folders inside a top-level folder bubble up to the project
  root via `PATCH /api/videos/batch` (`folderId` may now be null) or
  `PATCH /api/folders/[id]`. The button is hidden only at the project
  root, where there is nothing above.
- Drag-and-drop a video card onto a folder card to move the whole
  version group at once. `/api/videos/batch` PATCH now accepts an
  optional `folderId` (string | null) and validates that the target
  folder belongs to the same project. FolderCard lights up with a
  primary-ring affordance whenever any video is being dragged.
- "Share video" item in the VideoCard kebab — copies a deep-link to
  the project share with `?video=NAME&folderId=...` so the recipient
  lands straight on this video in the public player. Clipboard fallback
  uses `window.prompt` when the clipboard API is restricted.
- Project root grid now displays root-level videos (those moved up
  out of folders). `/api/folders?parentFolderId=root` returns
  `{ folders, videos }` with thumbnails/previews tokenised the same
  way as the folder GET; shared enrichment lives in
  `src/lib/folder-video-enrichment.ts`.

### Added — Player + share polish

- ArrowLeft / ArrowRight on the player step one frame at a time
  (falls back to ~30 fps when metadata isn't loaded yet, auto-pauses
  on first keypress, ignored while typing in an input).
- Sort dropdown on the projects dashboard is now a real dropdown
  (A-Z / Z-A); legacy Status / Due-Date entries removed.
- Public share folder page kebab is hidden for clients (no Rename /
  Share / Delete / Move up).
- "All Videos" button keeps its label when the player is opened from
  a folder share, but uses `router.back()` so admin returns to the
  admin folder browser instead of being kicked into the public share
  folder page. Title flyout + version dropdown are scoped to the
  source folder when one is present.

### Removed

- Calendar and Clients items in the admin top navigation. The
  underlying pages remain on disk; they just aren't linked anymore.

### Fixed

- Folder drag-drop with sub-folders no longer fails silently —
  the entry walk now snapshots `FileSystemEntry` objects inside the
  synchronous drop handler so awaits across the recursion don't
  invalidate the browser's drag references.
- `Move up one folder` on a video sitting in a top-level folder now
  succeeds, sending the group to the project root (`folderId = null`).
- Admin who clicks a video from a folder browser stays in the admin
  player (`/admin/projects/[id]/share?video=...`) instead of being
  bounced into the public share URL — preserves their delete/rename
  privileges and admin badges.
- Folder kebab and folder cover were sharing a stacking context with
  the page header; the dropdown now sits above any later page
  content (header gained explicit `relative z-50`).
- Comment delete no longer surfaces "Video not found" for stale rows
  — a 404 on one of the version ids is now treated as already gone
  and the listing refreshes so the ghost card disappears.
- POST `/api/comments` response now carries the same `Client N`
  guest index as the GET, so the UI doesn't briefly flash back to
  plain "Client" right after submitting.

## [1.0.6] - 2026-05-12

The "Frame.io parity" release. Projects become folders, folders become
real, videos stack as versions, and the whole admin grid is rewritten
to look + feel like Frame.io.

### Added — Folder tree inside projects

- New `Folder` model with self-referencing parent, project-scoped slugs,
  per-folder share `authMode` (NONE / PASSWORD; OTP deferred). Migration
  `20260512141041_add_folder_hierarchy`.
- Full CRUD API:
  - `POST /api/folders`, `GET /api/folders` (project root)
  - `GET/PATCH/DELETE /api/folders/[id]` with cycle detection, encrypted
    share password, cascade subfolder delete, `SetNull` for videos on
    folder delete.
  - `POST /api/videos/[id]/move` to drop a video into a folder.
- Public folder share endpoints:
  - `GET /api/share/folder/[slug]` with NONE / PASSWORD auth, share token
    issuance, descendant gating.
  - `POST /api/share/folder/[slug]/verify` with Redis lockout, security
    events, constant-time password compare.
- Admin folder browser UI: breadcrumb, drag-drop to move folders
  between levels, Frame.io-style right-click context menu (Upload Asset,
  Upload Folder, New Folder, New Restricted Folder).
- Public folder share page at `/share/folder/[slug]` renders the same
  `VideoCard` the admin uses — same size, version badge, comment
  count, duration, hover-scrub, uploader + date. Kebab is hidden.

### Changed — Frame.io-style dashboard

- Projects dashboard redesigned: each tile shows a deterministic gradient
  cover (HSL hashed from project id), lock overlay for password-protected
  projects, project name + folder count + total size (MB/GB/TB) +
  "Updated 2h ago", per-project kebab (Settings / Analytics / Copy share
  link / Archive / Delete). "+ New Project" tile lives at the end of the
  grid. `/api/projects` returns `folderCount` and `totalSize`.
- Project page collapses to a single folder grid: removed the right
  sidebar with status badge, client info, share link, project actions
  card. Project-level actions move into a top-bar ⋮ kebab next to
  Project Settings.
- Status tag (IN REVIEW / APPROVED / ARCHIVED / SHARE_ONLY) removed from
  the dashboard cards and from the project page sidebar — the lock
  overlay on the tile and the kebab's actions cover the same ground.
- "Create New Project" modal trimmed: Description, Company Name, Name,
  Email, Share Only fields gone. Authentication Method dropdown gone —
  it's now Password only by default. Require Authentication is
  unchecked by default.
- Filter chip on Projects Dashboard removed. The grid always shows
  every project, regardless of status.
- Stats bar above the dashboard (Projects / Videos / Visits / Downloads)
  removed.

### Added — Frame.io VideoCard

- New `VideoCard` component matching `FolderCard`'s rhythm: aspect-video
  cover, version badge top-right, comment count + duration overlays
  along the bottom, name + uploader + date subtext, kebab with
  Rename / Delete. Covers and folders sit in the same uniform grid
  inside `FolderBrowser`.
- Hover-scrub: every VideoCard preloads a tiny **storyboard sprite-
  sheet** (10×10 grid of 192×108 cells, ~50–150 KB) generated by a new
  FFmpeg pass in the worker. CSS `background-position` shifts cells as
  the cursor moves left-to-right — instant frame-accurate scrub, no
  network round-trip per frame. Falls back to seeking a 720p preview
  for legacy rows. Migration `20260512190000_add_video_storyboard`.
- `originalFileName` is preserved exactly on upload (no rename when
  filenames collide — instead we suffix the displayed name `(2)`,
  `(3)` etc., file-system style). Admin downloads use the original
  filename verbatim; client downloads on unapproved videos still use
  the obfuscated `ProjectTitle_quality.ext` form.
- Per-video uploader tracking via `Video.createdById` (migration
  `20260512175022_add_video_created_by`). The folder GET surfaces it as
  `createdBy` for the card subtext.

### Added — Frame.io versioning

- Every new upload starts as `v1` in its own group. Filename collisions
  no longer auto-stack — they get `(2)`, `(3)` suffixes instead.
- **Drag a video onto another video** to stack: the source's whole
  group is renumbered `targetMax+1, +2, …` and renamed to the source's
  filename (Frame.io convention: the freshly added video drives the
  display name of the stack). Comments stay attached to each
  `Video` row — switching to `v1` in the player dropdown shows v1's
  comments. New endpoint `POST /api/videos/[id]/stack` runs the
  whole renumber inside one Prisma transaction.
- Player header (ThumbnailReel) now displays the SELECTED version's
  original filename instead of the group name, matching Frame.io's
  per-version display.
- The duplicate v1/v2/v3 button row below the player is gone — the
  top-bar dropdown is the sole version surface.

### Added — Multi-select + bulk download

- Always-visible checkbox top-left of each VideoCard. Selecting one
  enters "selection mode" — clicking anywhere on another card toggles
  its selection without opening the video.
- Floating action bar (bottom-center) when items are selected: count,
  Clear (X), Download, Delete. Bulk download iterates the selected
  videos through `POST /api/videos/[id]/download-token` with a short
  delay between hits to defeat the popup blocker.
- "Download All" button next to "New Folder" pulls every video in the
  current folder.

### Added — Upload UX

- Frame.io empty state in folders: dashed drop zone with cloud icon,
  "Drag files and folders to begin." text, Upload button with a
  dropdown for **Upload files** / **Upload folder**
  (`webkitdirectory`).
- Drag-drop file upload works **anywhere** in the folder (empty or
  populated) thanks to a container-level handler + overlay.
- Drag-drop uploads now auto-start the pipeline and the modal
  auto-closes when every seeded file finishes — no more "Start
  Upload" click for drag-drop flows. The modal only stays open on
  error so the user can see what went wrong.
- New uploads land in the correct folder (the `folderId` now flows
  through `POST /api/videos` and is validated server-side).
- "Generating thumbnail…" placeholder + spinner inside the cover
  while the worker is still processing the upload. Replaced by the
  real thumbnail automatically — the folder page silently polls
  every 4s while any video is in `UPLOADING` / `PROCESSING`.

### Fixed

- `/api/folders/[id]` no longer 500s once a folder contains uploaded
  videos. `Video.originalFileSize` (BigInt) is serialised to string
  before `NextResponse.json`.
- Auto-polling on the folder drill page no longer flashes the
  full-screen "Loading…" view on every tick — `fetchFolder` accepts a
  `silent` option used by the poll loop.
- Worker dev script switched to `tsx watch` so schema / handler
  changes are picked up automatically (`npm run worker:dev`).
- Defensive folder GET surfaces the real Prisma `detail` error in the
  response body during 1.0.6 rollout so an un-migrated DB doesn't
  reduce to a generic "Failed to load folder".

### Removed

- Videos can no longer live at the project root. The project page is
  exclusively a folder grid; uploads happen inside folders. Existing
  root-level videos are not deleted but are not surfaced in the UI;
  use the API or move them into a folder by re-upload.
- Status badges (IN REVIEW / APPROVED / SHARE_ONLY / ARCHIVED) hidden
  from the admin dashboard and project sidebar surfaces.

## [1.0.5] - 2026-05-08

### Added

- **Range comments via the timeline.** Clicking the comment input
  captures the current playhead as the comment's IN point and paints
  a yellow bracket on the timeline plus a draggable handle above it.
  Pull the handle to the right (or click later on the track) to set
  the OUT point — the range is shown as a yellow bar and as an inline
  chip in the input (`[clock 02:19 → 02:24 ×]`). Drags snap to whole
  frames so it's easy to land on clean cuts. The video scrubs along
  with the drag so the user sees the exact frame the OUT lands on.
  Submitting the comment posts a comment with `timecodeEnd` set; the
  X on the chip clears the whole range.
- **Edit a comment's range.** Clicking Edit on a saved comment
  re-paints its IN/OUT range on the timeline with the same draggable
  handle. Adjusting the handle changes the comment's duration; the
  new `timecodeEnd` is sent in the `PATCH /api/comments/[id]` body
  alongside the new content. The PATCH schema now accepts optional
  `timecode` and `timecodeEnd`.
- **Copy / paste comments between versions.** Three-dot menu in the
  top-right of the comments sidebar (Frame.io-style) with two
  actions: **Copy comments** stores the active video's comments in a
  per-project localStorage clipboard; **Paste comments** POSTs each
  one against the currently-selected video, so a v1 → v2 review can
  re-use the same notes without typing them again. Copies text + IN/OUT
  range. Attachments and annotations are skipped in this MVP.
- **Resizable comments sidebar.** A thin drag handle on the left edge
  of the sidebar lets the user widen or narrow it on demand. Width
  persists in localStorage per project, clamped to 280px..55vw.
  Double-click the handle to reset to the default. Active only from
  the `lg` breakpoint up — on mobile the sidebar still stacks below
  the player.

### Changed

- **Frame.io-style flat-list comments.** The boxed card wrapper
  around each comment (border, shadow, large padding) is gone — the
  sidebar now reads as a flat conversation feed: small avatar, bold
  name + small timestamp + sequence number on a single header row, a
  compact yellow timecode chip, body text, and a minimal action row
  (Reply / pencil / trash). Replies inherit the same compact
  treatment.
- **Input placeholder reads "Leave your comment…".** Replaces the
  generic "Type your message…" so the call-to-action matches the
  product domain.

### Fixed

- **Horizontal scrollbar in the comments sidebar at xl widths.** The
  per-comment action row used to wrap when the sidebar narrowed
  below ~300px, producing a horizontal scrollbar at typical laptop
  resolutions. Edit / Delete labels now collapse to icons below `2xl`
  with hover tooltips, the gap is tighter, and the messages
  container uses `overflow-x-hidden` as a backstop.

### Internal

- New `PATCH /api/comments/[id]` schema accepts optional
  `timecode` / `timecodeEnd` (validated as proper SMPTE-style strings)
  so range edits land in the same request as the content edit.
- New `commentRangeStateChanged` window event broadcasts the pending
  IN/OUT range to whichever component owns the timeline; new
  `setCommentOutPoint` event flows the other direction (timeline drag
  → state holder).
- New `commentEditStart` / `commentEditCancel` window events
  coordinate edit-mode range editing between MessageBubble and
  CommentSection without prop drilling.
- New components: `CommentsKebabMenu`, `ResizableSidebar`. New
  utility: `src/lib/comments-clipboard.ts`.

## [1.0.4] - 2026-05-06

### Changed

- **Frame.io-style player layout.** The control bar and timeline now sit
  *below* the video in normal flow, on a black background that visually
  extends the video frame. The bar is permanently visible — the
  previous mouse-activity-based auto-fade is gone, and the video itself
  no longer has chrome painted on top of frames during playback.
- **Reorganised control bar.** Three sections, left → right: *transport*
  (play/pause, frame-by-frame on desktop, **playback speed selector**,
  volume) │ *time* (current / total) │ *quality badge* (HD/SD/4K,
  read-only) and *fullscreen*.
- **Top bar shows the filename and a version chip.** Replaces the older
  prev/next + "1/N" counter — that was just an ordinal and didn't tell
  you which file you were on. Clicking the chip opens a dropdown
  listing every version of the active video (newest first, with
  approval ticks). Selecting a version dispatches a
  `selectVideoVersion` window event that VideoPlayer picks up to swap
  streams in place. To switch to a *different* video, the user goes
  back to the All-Videos grid.
- **Bottom info strip is hidden.** The legacy filename + Approve + Info
  + Download row that sat under the player has been hidden — the
  filename now lives in the top bar, and Approve/Info will move into
  the top-right of the title bar in a follow-up.
- **Comments sidebar narrowed.** Width caps moved from 30% / 25% to
  **30% / 22% / 18%** across lg / xl / 2xl, with a 280px floor. Closer
  to Frame.io's proportions and gives the player more room.
- **Side-by-side layout from `lg`** (was `xl`). On a 1200px laptop or
  Nest Hub-style 1024×600, the comments no longer stack below the
  player and squeeze the video to ~70px tall.

### Added

- **Playback speed popup** (`PlaybackSpeedMenu`) with discrete steps
  **0.5 / 0.75 / 1 / 1.25 / 1.5 / 2 / 4 / 8**. Triggered by the small
  `1.0x` button in the control bar. Active step is highlighted; click
  sets `HTMLVideoElement.playbackRate`. Closes on outside click or
  Escape.
- **Mobile player matches the video's natural aspect ratio.** On
  phones, the wrapper now uses a CSS variable
  (`--video-ar = ${width}/${height}`) so a 9:16 portrait clip renders
  tall and a 16:9 landscape clip renders short. `max-h-[70vh]` keeps
  very tall portraits from monopolising the viewport, leaving room
  for controls and a peek at the comments.

### Fixed

- **Voice recorder UI overflowed the comments sidebar at narrow
  widths.** Both the recording-in-progress state (live waveform +
  duration + stop) and the post-record preview (audio + cancel +
  confirm) used `inline-flex` with fixed widths and pushed the Send
  button off the edge. They now use `flex flex-1 min-w-0` and the
  waveform / native audio control fluidly resize.
- **Voice recorder takes the full input row while active.** Sibling
  icon buttons (draw, paperclip) hide while recording or previewing
  via a new `onActiveChange` callback, so the recorder UI is no longer
  cramped.
- **Inline microphone-device picker removed from the comment row.**
  The row was overflowing on narrow sidebars; matches the Frame.io /
  Slack pattern of "use the OS default; switch in Settings".
- **Saved voice attachments now show a play button.** Chrome was
  collapsing the native &lt;audio&gt; element to just a 3-dot menu
  when squeezed below ~150px. The audio attachment row is now stacked
  (player on top, file size underneath) so the player gets the full
  width.
- **Comment action row no longer wraps awkwardly.** Edit and Delete
  collapse to icon-only with hover tooltips below `xl`, so
  `Reply [pencil] [trash]  #1` fits on a single tidy line at typical
  sidebar widths. Labels return at `xl+`.
- **"Feedback & Discussion" title** truncates with ellipsis instead
  of wrapping onto two lines on narrow sidebars.
- **"Press Enter to send & Shift+Enter for new line" hint** is hidden
  below `2xl` (the Shortcuts button covers the same ground; the hint
  was wrapping awkwardly at narrow widths).
- **Comments expanded by default on mobile.** Was hidden behind a tap
  on the section header; the user explicitly wanted Frame.io-style
  "video centred, comments below, no extra step".
- **Player layout no longer clips the control bar** at smaller
  windows. Switched to a fully-responsive `flex` column where the
  video wrapper uses `flex-1 min-h-0` (and `object-contain` on the
  &lt;video&gt; tag) and the control bar is `flex-shrink-0`. Total
  stack always fits the viewport from `lg+`.

### Internal

- New `playbackSpeed` / `onPlaybackSpeedChange` /
  `resolvedPlaybackQuality` props on `CustomVideoControls`.
- New `activeVideoId` prop on `ThumbnailReel`, plumbed through both the
  public share page and the admin share page via `onVideoStateChange`.
- New `selectVideoVersion` window event consumed by `VideoPlayer`.
- New `onActiveChange` callback on `VoiceRecorderButton`.
- Several layout breakpoint thresholds bumped from `xl:` to `lg:` so
  the desktop layout activates at 1024px instead of 1280px.

## [1.0.3] - 2026-05-06

### Added

- **Delete your own comments and replies.** A trash-can button now appears
  next to each comment for both admins and the original author. Authors
  are matched server-side via the per-share-session id stored at comment
  creation, so the same browser that wrote a comment can delete it later.
  `DELETE /api/comments/[id]` was extended to accept author session match
  in addition to admin auth.
- **Click a comment to jump the playhead.** Clicking anywhere on a
  comment bubble in the sidebar now seeks the video to that comment's
  exact moment, not just clicking the small clock badge.
- **Sub-second seek precision (`timestampMs` column).** Comments now
  store the millisecond-accurate moment they were left at, in addition
  to the frame-quantised `timecode` string used for display. Click-to-
  seek lands the playhead exactly where the user paused, instead of on
  the nearest frame boundary (which lost up to ~21ms at 24fps). Legacy
  comments without `timestampMs` fall back gracefully to the timecode-
  derived seconds. Migration: `20260505172906_add_comment_timestamp_ms`.
- **Frame.io-style timeline markers.** Comment markers on the player
  timeline are now small fully-opaque coloured notches sitting on the
  track itself, with a separate row of identity chips (initials avatars)
  rendered immediately below. Click + hover behave like before — seek,
  scroll-to-comment, tooltip — but the markers no longer fight visually
  with the playhead.

### Fixed

- **Voice-only comments rejected with a misleading "too long" error.**
  `validateCommentLength` treated empty content as "too long" and
  surfaced a 10,000-character ceiling error when posting an audio-only
  comment. Empty content is now valid at the helper layer; the upstream
  zod refinement still requires *something* (text, attachment, or
  annotation) before the request is accepted.
- **"Only admins can delete comments" alert blocked authors from using
  Delete.** A leftover client-side guard in `useCommentManagement` was
  tripping before the request reached the server. Removed; authorisation
  is now exclusively server-side. Also removed a duplicate `confirm()`
  prompt — the dialog now fires once.
- **Share session revocation could permanently lock `authMode=NONE`
  projects.** For NONE-mode projects the share `sessionId` is
  deterministic (`none:<projectId>:<ip>`); a stale `revoked:share_session:*`
  Redis entry would reject every freshly-issued JWT, leaving the player
  stuck on "Loading video…" with no way to recover via reload.
  `verifyShareToken` now skips session revocation for NONE-mode tokens
  (token-level revocation still works for surgical kills).
- **Admin couldn't preview unapproved videos when transcoding was
  skipped.** The admin share page only requested an `original` token as
  a fallback if `video.approved === true`, which combined with
  `skipTranscoding=true` (no 720p/1080p/2160p variants) left every
  stream URL empty until approval. The fallback is now unconditional —
  the admin endpoint already enforces admin auth, so the original is
  never exposed past the studio.

### Internal

- New `Comment.timestampMs Int?` column (nullable, backward-compatible).
- `verifyShareToken` no longer consults `isShareSessionRevoked` for
  `authMode=NONE` JWTs.
- Diagnostic scripts in `scripts/` (`debug-video-state.ts`,
  `debug-share-token.ts`, `clear-share-session-revocation.ts`,
  `redis-inspect.ts`) for reproducing the share/Redis lockout offline.

## [1.0.2] - 2026-05-04

### Added

- **Edit your own comments and replies.** A pencil "Edit" button now appears
  next to each comment for the original author and for admins. The new
  endpoint is `PATCH /api/comments/[id]`. Authorization is enforced via a
  per-share-session id (admins can override).
- **Voice messages on comments.** A new microphone icon next to the
  attachment paperclip records audio (up to 5 minutes) and attaches it to
  the comment. Includes a live waveform during recording, an inline audio
  player on saved comments, and a microphone-device picker for users with
  multiple inputs.
- **New annotation shapes — arrow, line, rectangle.** The comment drawing
  tools used to be freehand-only; you can now drop arrows, straight lines,
  and rectangles on top of any frame. Arrows scale with drag length so a
  short arrow stays delicate and a long arrow gets visibly thicker.
- **Inline annotation toolbar.** The drawing toolbar is now rendered inside
  the comment input row (Frame.io-style), so picking a tool/colour and
  reviewing your sketch happens without leaving the comment area. The video
  is no longer dimmed while drawing.
- **Single back arrow replaces the old Cancel/Done pair.** Pressing back
  commits the drawing if any shapes exist, otherwise cancels. Pressing
  Send (or Enter) while drawing now auto-commits the drawing first, so you
  can post in one click without a separate finish step.
- **Click-to-pin annotation.** Clicking a comment in the sidebar surfaces
  its drawing on the video and seeks to its timecode. Drawings stay strictly
  bound to their comment's timecode — they appear when the playhead reaches
  the frame and disappear once it moves on.
- **Image attachments render as previews + click-to-zoom lightbox.** Image
  files attached to comments now show as a small grid of thumbnails inline.
  Clicking a thumbnail opens a full-screen lightbox; Esc / outside-click
  closes it. Non-image attachments keep the existing download row.
- **Submit without text.** Comments containing only an attachment, voice
  message, or annotation can now be posted with an empty text body. We no
  longer auto-fill placeholder text such as `Attachments uploaded #1` or
  `Drawing annotation`.
- **Annotation colour palette restricted to 3.** The toolbar now offers
  red / orange / green only, mapped to a clearer shared meaning across
  reviewers (problem / note / approved). Existing annotations with other
  colours continue to render correctly.
- **Cmd+Z / Cmd+Shift+Z redo support.** The drawing surface now keeps both
  an undo and a redo stack, with the standard keyboard shortcuts.

### Changed

- **Localisation reduced to English.** Dutch (`nl`) and German (`de`)
  translation bundles have been removed. The single-language language
  switcher is hidden automatically when only one locale is available.
- **`Permissions-Policy` allows microphone for the comment recorder.**
  Camera and geolocation remain disabled.
- **Stricter annotation render gating.** Drawings on saved comments only
  render while the playhead is inside the comment's timecode window.
  Pending (just-drawn) drawings render on a slightly more generous window
  while the user is still composing their comment.

### Fixed

- **Annotations were silently dropped server-side.** The validation schema
  for `Comment.annotations` only accepted the legacy `freehand` shape; the
  new `arrow`, `line` and `rectangle` shapes were stripped during request
  parsing and never persisted. Schema is now a discriminated union over
  all four shape types.
- **`audio/webm` was rejected by the asset uploader.** Browser voice
  recordings produce `audio/webm` (Chrome/Firefox) or `audio/mp4` (Safari);
  both are now allowed extensions and MIME types.
- **PostgreSQL 18 fresh-install error revisited.** Already pinned in 1.0.1
  for the project compose files; the TrueNAS catalog template now also
  pins `PGDATA` to `/var/lib/postgresql/data`.

### Improved (developer experience only — no production impact)

- New `npm run worker:dev` is registered as a script alias.
- Added a configurable preview-LUT path via `PREVIEW_LUT_PATH` for local
  development outside Docker.
- Inline TUS auth header added to the voice recorder upload path so it
  authenticates the same way attachment uploads do.

### Internal

- New `editorSessionId` column on `Comment` (Prisma migration
  `20260504184125_add_comment_editor_session_id`). Stores the share-token
  session id of the original author so they can edit their own comment
  later from the same browser.
- New `AnnotationProvider` React context wraps the share and admin share
  pages. Drawing state, mode, and pending-annotation lifecycle are now
  shared between `VideoPlayer` and `CommentInput` via context instead of
  window events alone.

## [1.0.1] - 2026-05-04

### Removed

- **Client-facing onboarding tutorial.** New share links no longer trigger a
  `driver.js`-based "Welcome / This page lets you watch videos…" walkthrough
  for clients. The `<ShareTutorial>` component is no longer rendered on the
  public share page, and the per-project default for `showClientTutorial` has
  been flipped from `true` to `false` for newly created projects.

### Fixed

- **Postgres 18 fresh-install failure.** Postgres 18 changed its default data
  directory layout (`PGDATA` now points at `/var/lib/postgresql/<major>/docker`
  instead of `/var/lib/postgresql/data`), which made fresh installs against an
  empty `/var/lib/postgresql/data` mount fail with *"unused mount/volume"*. We
  now pin `PGDATA` to the legacy path in `docker-compose.yml`,
  `docker-compose.truenas.yml`, `docker-compose.unraid.yml`, and the TrueNAS
  catalog template. Existing 1.0.0 installs are unaffected.

### Improved (developer experience only — no production impact)

- **`npm run worker:dev`** new script that loads `.env` (or `.env.local`) before
  starting the worker, so local-dev runs of the worker pick up `STORAGE_ROOT`,
  `DATABASE_URL`, etc. without manual env exports.
- **CSP relaxed in development mode** — `'unsafe-eval'` and `'unsafe-inline'`
  are added in dev so React Refresh / Turbopack work without console errors.
  Production CSP is unchanged (strict nonce-based policy).
- **`PREVIEW_LUT_PATH` env var** — overrides the hard-coded `/usr/share/ffmpeg/previewlut.cube`
  so the worker can find the LUT file when running natively on a developer's
  machine. Default unchanged in Docker.
- **`docs/DEV-LOCAL.md`** added with a step-by-step local-development guide.

## [1.0.0] - 2026-05-02

### Initial release

FrameComment 1.0.0 is the inaugural release of this project. It is a friendly
fork of [ViTransfer 1.0.2](https://github.com/MansiVisuals/ViTransfer) by
[MansiVisuals](https://github.com/MansiVisuals), licensed under AGPL-3.0-only.
All upstream functionality is preserved; the project has been rebranded and
re-packaged for independent distribution and a new release cycle.

### Changed

- **Project rename** — every occurrence of `ViTransfer` / `vitransfer` /
  `VITRANSFER` has been replaced with `FrameComment` / `framecomment` /
  `FRAMECOMMENT` across source, configuration, documentation, translations
  (en, nl, de), Docker / Quadlet manifests, GitHub Actions workflows, and the
  PWA manifest.
- **Docker image** — the published image moves from `mansivisuals/vitransfer`
  (and the older `crypt010/vitransfer`) to `dragosonisei/framecomment`.
- **Repository home** — the canonical source repository is now
  `https://github.com/DragosOnisei/FrameComment`.
- **Author / maintainer metadata** in `package.json` updated to Dragos Onisei
  &lt;dragosonisei@gmail.com&gt;. License remains AGPL-3.0-only.
- **Quadlet unit files** renamed from `vitransfer-*.{container,network}` to
  `framecomment-*.{container,network}`.

### Added

- **Attribution** — a `NOTICE` file documenting the upstream attribution and
  AGPL-3.0 obligations, plus a "Credits & Attribution" section in the README
  and a discreet upstream link in the in-app footer.
- **TrueNAS SCALE app catalog skeleton** — `truenas-catalog/framecomment/`
  containing the chart layout (`app.yaml`, `questions.yaml`, `templates/`,
  `metadata.yaml`, `README.md`) so FrameComment can be installed via a custom
  TrueNAS SCALE catalog while we work toward a fully polished chart in 1.1.x.
- **Release tooling** — `docs/RELEASING.md` with a documented SemVer + GitHub
  Releases flow, plus a GitHub Actions workflow that builds a multi-arch
  Docker image and publishes a GitHub Release on tag push (`v*`).

### Removed

- Donation / sponsorship links to the upstream author have been removed from
  the README, in-app footer, and wiki. (The legal AGPL-3.0 attribution to
  MansiVisuals is preserved.)

### Notes for users coming from ViTransfer

- The application schema, environment variables, and HTTP routes are
  unchanged in 1.0.0; an existing ViTransfer install can be migrated by
  swapping the Docker image and updating `container_name` references.
- The configuration variable prefixes (e.g. database name defaults, network
  names) have been renamed; review `docker-compose.yml` and your `.env`
  before upgrading. Detailed migration notes will be added in 1.0.1.

[Unreleased]: https://github.com/DragosOnisei/FrameComment/compare/v1.0.5...HEAD
[1.0.5]: https://github.com/DragosOnisei/FrameComment/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/DragosOnisei/FrameComment/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/DragosOnisei/FrameComment/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/DragosOnisei/FrameComment/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/DragosOnisei/FrameComment/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/DragosOnisei/FrameComment/releases/tag/v1.0.0
