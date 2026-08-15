# Client Guide

This guide is for clients and reviewers who receive a FrameComment share link to watch videos, leave feedback, and download deliverables.

## Opening a share link

Your video team will send you a link like `https://example.com/share/abc123`. Open it in any modern browser (Chrome, Firefox, Safari, Edge) on desktop or mobile.

## Logging in

Depending on the project settings, you may need to authenticate before viewing:

**Password**
Enter the password provided by your video team and click **Submit**.

**Email code (OTP)**
Enter your email address and click **Send Code**. Check your inbox for a 6-digit code, enter it, and click **Verify**. Use the **Back** button to re-enter your email if needed.

**Password + Email code**
Both options are shown. You can use either one.

**Guest access**
Some projects allow guest viewing. Click **Continue as Guest** to enter without credentials. Guest access is view-only — you cannot comment or download. Depending on the project settings, guests may only see the latest version of each video.

After logging in, your session is saved so you can refresh the page without re-entering credentials.

## Privacy banner

Some projects display a privacy disclosure banner on first visit. You can read the full disclosure and choose to accept or decline analytics tracking. Your preference is stored for the session.

## Video grid

After authentication you see a thumbnail grid of all videos in the project:

- Each card shows a thumbnail, the video name, and a version count badge.
- Click any thumbnail to open the video player.

Above the grid you can see the project title, your name, and an optional project description.

In the top-left corner of the grid, depending on what the project admin has enabled, you may see:

- **Download All Videos** — downloads every video in the project. A flat folder of 15 files or fewer is delivered as individual files; anything larger, or a folder with subfolders, arrives as a single ZIP.
- **Submit Files** — opens an upload panel to send files directly to the project (see [Submitting files](#submitting-files-to-the-project) below).

If this is your first visit, an interactive tutorial overlay may guide you through the main features of the review page.

## Video player

### Playback controls

The player bar at the bottom of the video includes:

| Control | Description |
|---------|-------------|
| **Previous frame** | Step back one frame (pauses playback) |
| **Play / Pause** | Start or stop playback |
| **Next frame** | Step forward one frame (pauses playback) |
| **Timecode** | Current position and total duration |
| **Volume** | Click to mute/unmute, hover for slider |
| **Fullscreen** | Enter or exit fullscreen mode |

### Timeline

- Click or drag anywhere on the timeline bar to seek.
- Colored dots on the timeline mark where comments have been placed. Hover over a dot to see the commenter name and a preview of the comment.
- Colored range bars highlight sections covered by ranged comments (e.g. "fix from 00:15 to 00:22").

### Playback speed

Speed can be adjusted between 0.25x and 2.0x. A badge appears on the video when speed is not 1.0x.

### Keyboard shortcuts

All shortcuts use **Ctrl** (or **Cmd** on Mac):

| Shortcut | Action |
|----------|--------|
| Ctrl + Space | Play / Pause |
| Ctrl + J | Previous frame |
| Ctrl + L | Next frame |
| Ctrl + , | Decrease speed (by 0.25x) |
| Ctrl + . | Increase speed (by 0.25x) |
| Ctrl + / | Reset speed to 1.0x |

## Versions

If the video has multiple versions (revisions), version buttons appear above the player. Click a version to switch.

- The current version is highlighted.
- Every version stays visible — nothing is hidden as the project progresses.

### Comparing versions

When two or more versions exist, a **Compare** button appears. Click it to open a fullscreen comparison view:

- **Side-by-side**: Both versions play next to each other with synced controls.
- **Slider**: An overlay mode where you drag a vertical divider to reveal each version.
- Playback, seeking, and speed controls affect both videos simultaneously.
- On mobile, side-by-side stacks vertically (top/bottom).
- Press **Escape** or the X button to close.

## Commenting

The comment panel appears to the right of the video on desktop, or below the video on mobile (tap to expand).

### Writing a comment

1. Type your feedback in the text field at the bottom of the comment panel.
2. The current video timestamp is captured automatically so your comment is linked to the exact moment.
3. Click **Send** to post your comment.

### Ranged comments

To mark a range (e.g. "the color is off from here to here"):

1. Set the start time by pausing at the beginning of the range.
2. Use the range selector to set an end time.
3. Your comment will appear as a highlighted bar on the timeline.

### Drawing annotations

1. Pause the video at the frame you want to annotate.
2. Click the annotation/drawing tool.
3. Draw freehand on the video frame using the color picker and opacity controls.
4. Use undo/redo to adjust.
5. Submit — the drawing is attached to your comment at the current timecode.

### Replying

Click **Reply** on any existing comment to add a threaded response.

### Attachments

If enabled by the project, you can attach files to your comments using the attachment button or drag-and-drop. Uploads use resumable transfers, so large files can recover from interruptions.

### Comment visibility

- Each commenter gets a unique color for their timeline markers.
- Click any timestamp in a comment to jump the video to that moment.
- If the project has "hide feedback" enabled, you will only see your own comments.

## Submitting files to the project

If the project admin has enabled file submissions, a **Submit Files** button appears in the top-left corner of the video grid.

1. Click **Submit Files** to open the upload panel.
2. Drag and drop files into the panel, or click inside it to browse.
3. Up to 10 files can be queued at once. Unsupported file types are flagged immediately.
4. Click **Submit Files** in the panel footer to start uploading. Progress is shown per file.
5. Once all files are uploaded, click **Done** to close the panel.

Files you submit are visible to the project admin but are not attached to any specific video or comment — they go directly to the project.

## Downloading

Downloads are available whenever the project admin has enabled them (not in guest mode):

- Click the **Download** button and pick a quality, or the original file.
- If the project has additional assets (images, audio, project files), a download dialog lets you select which files to download.
- With downloads enabled, a **Download All Videos** button appears in the top-left corner of the grid.

## Theme and language

In the top-right corner of the page you can:

- **Switch theme**: Toggle between light and dark mode.
- **Switch language**: Change the interface language (English, Dutch, or German).

Your preference is saved for future visits.

## Mobile tips

- The comment panel starts collapsed on mobile. Tap the header to expand it.
- Swipe on the timeline to scrub through the video.
- Version buttons scroll horizontally if there are many versions.
- Side-by-side comparison stacks vertically on small screens.
- All controls are touch-optimized with larger tap targets.

## Deep links

Your video team may send you a link that opens a specific video, version, or comment directly:

- `?video=Name` — opens a specific video
- `?version=2` — selects a specific version
- `?t=45.5` — seeks to a specific time (in seconds)
- `?comment=abc123` — scrolls to and highlights a specific comment

These can be combined, e.g. `https://example.com/share/token?video=Hero%20Reel&t=120`.

## FAQ

**Q: The video looks blurry.**
A: Playback starts on the fastest available quality tier and climbs as higher tiers finish encoding. You can pick a quality manually from the player's settings menu.

**Q: I can't see the comment section.**
A: On mobile, comments are collapsed by default — tap the comment header to expand. If you entered as a guest, comments are hidden.

**Q: My session expired.**
A: Refresh the page and re-enter your password or request a new email code.

**Q: I can't download the video.**
A: Downloads have to be enabled by the project admin, and they are never available in guest mode.

---
Navigation: [Home](Home) | [Features](Features) | [Installation](Installation) | [Platform Guides](Platform-Guides) | [Configuration](Configuration) | [Admin Settings](Admin-Settings) | [Usage Guide](Usage-Guide) | [Client Guide](Client-Guide) | [Security](Security) | [Maintenance](Maintenance) | [Troubleshooting](Troubleshooting) | [Screenshots](Screenshots) | [Contributing](Contributing) | [License](License)
