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
