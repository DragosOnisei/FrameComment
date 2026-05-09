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
