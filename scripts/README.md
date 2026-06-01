# FrameComment ops scripts

## bulk-upload.mjs — migrate a folder tree into FrameComment

Node.js CLI that walks a filesystem folder tree and uploads everything
through the official FrameComment TUS pipeline (so transcoding,
thumbnailing, HLS — all of it kicks in automatically just like a
browser upload would). Built for the case where browser drag-and-drop
isn't a realistic option: thousands of files spread over hundreds of
folders, multi-terabyte libraries, etc.

### Why not just drag the folders into the browser

The browser has to enumerate every file in the dropped tree at once
before any upload starts. At ~2 TB / 4000 files it runs out of heap,
and if the tab is closed mid-upload the per-file TUS fingerprints are
lost. This script does the same end-to-end thing one file at a time,
persists progress to a JSON state file, and resumes cleanly after any
kind of interruption (Ctrl-C, kill -9, network drop, laptop sleep).

### Prerequisites

- Node.js 18+ on the machine doing the uploading (Node 18 is the
  earliest with `fetch` built in).
- `tus-js-client` from this repo's `node_modules` (already a dependency).
  Run `npm install` once at the repo root before launching the script.
- Admin email + password for the FrameComment instance.

### Quick start (using env vars — safer)

```bash
# Set creds once per terminal session. `read -s` echoes nothing
# so the password stays out of shell history.
export FRAMECOMMENT_BASE_URL=http://192.168.100.20:4321
export FRAMECOMMENT_EMAIL=admin@example.com
read -s FRAMECOMMENT_PASSWORD; export FRAMECOMMENT_PASSWORD

# Always run with --dry-run first.
node scripts/bulk-upload.mjs \
  --source /Volumes/Windows/04_DFFR \
  --project '04_DFFR' \
  --dry-run

# Looks good? Drop --dry-run.
node scripts/bulk-upload.mjs \
  --source /Volumes/Windows/04_DFFR \
  --project '04_DFFR'
```

Inline flags also work if you prefer (`--base-url`, `--email`,
`--password`). The flags override env vars when both are set.

### Full flag list

| Flag                   | Required | Default                | Notes |
| ---------------------- | -------- | ---------------------- | ----- |
| `--base-url`           | yes      | —                      | `http://...` or `https://...`, no trailing slash needed |
| `--email`              | yes      | —                      | Admin email |
| `--password`           | yes      | —                      | Admin password (quote it if it has shell-special chars) |
| `--source`             | yes      | —                      | Local folder to ingest (absolute path) |
| `--project`            | yes      | —                      | Target project title. Created if it doesn't exist; matched by exact title if it does |
| `--state`              | no       | `<source>/.bulk-upload-state.json` | Where to persist done-files + folder-id cache |
| `--concurrency`        | no       | `2`                    | Number of files in flight at once. Bump to 4–6 on gigabit LAN |
| `--dry-run`            | no       | off                    | Walk + report only |
| `--extensions`         | no       | `mp4,mov,m4v,avi,mkv,webm,jpg,jpeg,png,gif,webp` | Comma list, no dots |
| `--skip-existing`      | no       | on                     | Skip files already in the state file |
| `--no-skip-existing`   | no       | off                    | Force re-upload (rare) |
| `--verbose`            | no       | off                    | Log every API call + folder creation |

### What it does, step by step

1. **Log in** at `POST /api/auth/login` → keeps the JWT access token
   in memory, refreshes it ~60 s before expiry.
2. **Find or create the target project** — exact-title match against
   `GET /api/projects`; if none, `POST /api/projects` with
   `authMode: 'NONE'`. The project id is cached in the state file
   so re-runs don't re-search.
3. **Enumerate the source tree** — depth-first walk, filter by
   extension, skip dotfiles and `Thumbs.db`. Total file count + total
   size are printed up front.
4. **Group files by their parent folder** so we don't ping
   `/api/folders` once per file when uploading hundreds in the same
   directory.
5. **For each folder**, walk down the relative path and ensure every
   segment exists via `GET /api/folders?projectId=...&parentFolderId=...`
   (match by name) and `POST /api/folders` for the missing ones. The
   resolved folder id is cached.
6. **For each file**, create the `Video` DB row with
   `POST /api/videos` (passing `folderId`), then run the TUS upload
   pointing at `/api/uploads` with `{ filename, filetype, videoId }`
   metadata. Same wire protocol the in-app upload uses.
7. **Persist after every success** — state file gets rewritten
   atomically (`.tmp` + rename) every time a file finishes, so the
   process can die at any moment without losing more than the
   current in-flight upload.

### Resume behaviour

- `state.completed[relativePath]` skips done files.
- TUS's own fingerprint store (`~/.bulk-upload-tus-store/`) resumes a
  half-uploaded file from its last acknowledged offset.
- Together they mean: kill the process, plug your laptop in for the
  night, run the exact same command tomorrow → it picks up where it
  was, no re-uploads of completed files, partial files resume from
  their last byte.

### Estimating runtime

At gigabit LAN throughput a Mac → TrueNAS upload tops out around
80–100 MB/s sustained (HTTP overhead included). 2.8 TB at that rate
is in the 8–10 hour range for raw data. The per-file overhead
(create Video row, ensure folders, TUS handshake) adds ~0.5 s per
file, so 4000 files × 0.5 s ≈ 35 min extra. Realistic ETA: 9–11 h
for the largest project, ~45 min for 04_DFFR. Bump `--concurrency`
on slower-per-stream links (cloud, VPN).

### Suggested run order

1. **Smoke test** with `04_DFFR` (smallest, 4.7 GB). Verify videos
   appear in the dashboard, transcoding kicks in, the folder tree
   matches.
2. Then `02_DFT` (78 GB) — most boring, fewest folders.
3. Then `03_FFN` (85 GB).
4. Finally `01_VDA` (2.6 TB) — overnight + the next morning.

### Troubleshooting

- **"Login failed: HTTP 401"** — wrong email/password.
- **"HTTP 413"** during TUS — `settings.maxUploadSizeGB` is too low.
  Bump it in Admin → Settings.
- **Network keeps dropping** — lower `--concurrency` to 1 so retries
  only have to recover one file at a time.
- **Want to wipe state and start over** — delete the state file at
  the path printed by the script on startup. The server-side videos
  stay; the next run will detect the title collision and either skip
  via the existing-name check inside POST /api/videos, or create a
  new version label if the server's dedup logic is more lenient.
