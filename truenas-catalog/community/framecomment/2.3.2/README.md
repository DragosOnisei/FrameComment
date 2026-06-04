# FrameComment 1.0.1

Patch release. Drop-in upgrade from 1.0.0.

## What's new in 1.0.1

* **Client-facing tutorial removed.** New share links no longer pop up a "Welcome / This page lets you watch videos…" walkthrough for clients.
* **Postgres `PGDATA` pinned.** Fresh installs no longer hit the Postgres 18 "directory layout changed" error on first boot.
* **Internal:** improved local-development workflow, permissive CSP in dev mode, configurable preview LUT path. No effect on TrueNAS users.

See the full release notes at
https://github.com/DragosOnisei/FrameComment/releases/tag/v1.0.1.

---

## What you'll be asked to configure

When you click **Install** on FrameComment from the catalog, TrueNAS SCALE
will render a form (defined in [`questions.yaml`](./questions.yaml)) and ask
you to provide:

* **Application configuration**
  * Admin email and admin password (the first user created on startup)
  * Admin display name (optional)
  * Time zone

* **Networking**
  * Web port (default: `30041` mapped to `4321` inside the container; pick a
    port in the SCALE node-port range, typically `9000`–`65535`)

* **Storage** — host paths or ix-volumes for:
  * `/app/uploads` (video and project files)
  * PostgreSQL data
  * Redis data

* **Secrets** (auto-generated if you leave them blank)
  * `POSTGRES_PASSWORD`
  * `REDIS_PASSWORD`
  * `ENCRYPTION_KEY` (32 bytes, base64)
  * `JWT_SECRET`
  * `JWT_REFRESH_SECRET`
  * `SHARE_TOKEN_SECRET`

* **Object storage (optional)**
  * If you toggle on S3, you'll be asked for `S3_ENDPOINT`, `S3_BUCKET`,
    `S3_REGION`, and the access keys. With S3 off, FrameComment uses the
    local `/app/uploads` mount.

## Default port mapping

| Container | Port | Host node port (default) |
|-----------|------|--------------------------|
| `app` | `4321` | `30041` |
| `postgres` | `5432` | (internal only) |
| `redis` | `6379` | (internal only) |

You can override the host node port from the install form.

## After install

* Open `http://<your-truenas-host>:30041` (or the port you chose).
* Log in with the admin email and admin password from the install form.
* Continue with the [Configuration guide](https://github.com/DragosOnisei/FrameComment/blob/main/docs/wiki/Configuration.md).

## Upgrading

Future releases (1.0.1, 1.1.0, …) will appear under
**Apps → Installed → FrameComment → Update Available**. Always read the
release notes in [`CHANGELOG.md`](https://github.com/DragosOnisei/FrameComment/blob/main/CHANGELOG.md)
before upgrading and back up your storage volumes (3-2-1 rule).
