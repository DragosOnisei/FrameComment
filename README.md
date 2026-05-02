# FrameComment

**Self-hosted Video Review & Approval Platform for Filmmakers**

FrameComment is a self-hosted web app for video teams to share work with
clients, collect feedback, and manage approvals.

[![Docker Pulls](https://img.shields.io/docker/pulls/dragosonisei/framecomment)](https://hub.docker.com/r/dragosonisei/framecomment)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![GitHub](https://img.shields.io/badge/github-DragosOnisei%2FFrameComment-blue)](https://github.com/DragosOnisei/FrameComment)
[![Release](https://img.shields.io/github/v/release/DragosOnisei/FrameComment?include_prereleases&sort=semver)](https://github.com/DragosOnisei/FrameComment/releases)

[![Clean Install Test](https://github.com/DragosOnisei/FrameComment/actions/workflows/test-clean-install.yml/badge.svg)](https://github.com/DragosOnisei/FrameComment/actions/workflows/test-clean-install.yml)
[![Upgrade Test](https://github.com/DragosOnisei/FrameComment/actions/workflows/test-upgrade.yml/badge.svg)](https://github.com/DragosOnisei/FrameComment/actions/workflows/test-upgrade.yml)

---

> **v1.0.0** — Initial release of FrameComment, forked from
> [ViTransfer 1.0.2](https://github.com/MansiVisuals/ViTransfer) by
> [MansiVisuals](https://github.com/MansiVisuals) on 2026-05-02. See
> [CHANGELOG.md](./CHANGELOG.md) and [NOTICE](./NOTICE) for details. Always
> maintain backups following the 3-2-1 principle (3 copies, 2 different media,
> 1 offsite) and check release notes before updating.

---

## Quick Start (Docker)

1. Download [`docker-compose.yml`](docker-compose.yml) and [`.env.example`](.env.example).
2. Copy `.env.example` to `.env` and generate the required secrets.
3. Start with `docker compose up -d`.
4. Open `http://localhost:4321` and log in.

The published image is `dragosonisei/framecomment` on Docker Hub.

## Install on TrueNAS SCALE

FrameComment ships with a custom-app skeleton at
[`truenas-catalog/framecomment/`](./truenas-catalog/framecomment/) for
TrueNAS SCALE 24.10+ (Electric Eel) Docker apps. Two paths are supported:

1. **Custom App via Docker Compose** — copy
   [`docker-compose.truenas.yml`](docker-compose.truenas.yml) into TrueNAS
   SCALE under *Apps → Custom App → YAML*.
2. **Private catalog** — add this repository as a custom catalog under
   *Apps → Discover → Manage Catalogs* and select the `truenas-catalog`
   directory. See [`truenas-catalog/framecomment/README.md`](./truenas-catalog/framecomment/README.md)
   for step-by-step instructions.

A polished public catalog submission is planned for 1.1.x.

## Documentation

The full documentation is mirrored under [`docs/wiki`](docs/wiki/).

| Topic | Link |
|-------|------|
| Home | [docs/wiki/Home.md](docs/wiki/Home.md) |
| Installation | [docs/wiki/Installation.md](docs/wiki/Installation.md) |
| Configuration | [docs/wiki/Configuration.md](docs/wiki/Configuration.md) |
| Admin Settings | [docs/wiki/Admin-Settings.md](docs/wiki/Admin-Settings.md) |
| Client Guide | [docs/wiki/Client-Guide.md](docs/wiki/Client-Guide.md) |
| Troubleshooting | [docs/wiki/Troubleshooting.md](docs/wiki/Troubleshooting.md) |
| Releasing | [docs/RELEASING.md](docs/RELEASING.md) |

## Screenshots

| | |
|---|---|
| **Login** | **Dashboard** |
| <img src="docs/screenshots/Login Page.png" alt="Login Page" width="400"> | <img src="docs/screenshots/Dashboard.png" alt="Dashboard" width="400"> |
| **Project View** | **Video Review** |
| <img src="docs/screenshots/Project View.png" alt="Project View" width="400"> | <img src="docs/screenshots/Share Page - Player View.png" alt="Share Page - Player View" width="400"> |
| **Version Compare** | **Approved Project** |
| <img src="docs/screenshots/Share Page - Slider Compare.png" alt="Share Page - Slider Compare" width="400"> | <img src="docs/screenshots/Share Page - Approved.png" alt="Share Page - Approved" width="400"> |

## Contributing

Feedback, issues, and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md)
and the project [Discussions](https://github.com/DragosOnisei/FrameComment/discussions).

## Credits & Attribution

FrameComment is a friendly fork of [**ViTransfer**](https://github.com/MansiVisuals/ViTransfer)
by [**MansiVisuals**](https://github.com/MansiVisuals), released under
**AGPL-3.0**. We are grateful for the upstream work that made FrameComment
possible.

If you are looking for the original project, please visit
[github.com/MansiVisuals/ViTransfer](https://github.com/MansiVisuals/ViTransfer).
A summary of the changes introduced in this fork is available in
[`CHANGELOG.md`](./CHANGELOG.md), [`docs/FORK-DIFF.md`](./docs/FORK-DIFF.md)
and the [`NOTICE`](./NOTICE) file.

## License

FrameComment is released under the **GNU Affero General Public License version
3.0 (AGPL-3.0-only)** — see [LICENSE](./LICENSE) for the full text and
[`NOTICE`](./NOTICE) for attribution and source-availability notices required
by section 5 of the license.

## Support

- [Issues](https://github.com/DragosOnisei/FrameComment/issues)
- [Discussions](https://github.com/DragosOnisei/FrameComment/discussions)
- [Docker Hub](https://hub.docker.com/r/dragosonisei/framecomment)

---

Made for filmmakers and video professionals.
