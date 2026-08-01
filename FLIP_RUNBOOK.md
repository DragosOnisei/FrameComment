# RLS Flip Runbook — activating database-level tenant isolation

> **What "the flip" is:** today the app connects to Postgres as `framecomment`,
> which is a **superuser** — Postgres superusers bypass Row-Level Security
> entirely, so the org-isolation policies (shipped in 5.0) are dormant and
> isolation relies on app-level filtering alone. The flip moves the **app**
> onto the restricted `framecomment_app` role so RLS actively enforces, at the
> database layer, that no query can ever touch another company's rows — even
> if a future code bug forgets a filter. The **worker** and **migrations**
> stay on the admin role.
>
> **When to flip:** after 5.5.0 has been running cleanly in production for a
> while, and BEFORE opening registration to other companies
> (`REGISTER_INVITE_CODE` on live).

---

## 0. Preconditions

- App version **≥ 5.5.0** running on TrueNAS (entrypoint + compose support).
- A recent config backup and DB dump (or ZFS snapshot of the Postgres dataset):

  ```bash
  # on TrueNAS, adjust dataset names to yours
  zfs snapshot tank/apps/framecomment/postgres@pre-rls-flip
  ```

- 10 minutes of acceptable downtime (one app-container restart).

## 1. Give the restricted role a password

The `framecomment_app` role already exists (created NOLOGIN by migration
`20260801130000_multi_tenant_rls`, with all GRANTs in place). Open a `psql`
shell inside the Postgres container:

```bash
docker exec -it framecomment-postgres psql -U framecomment -d framecomment
```

```sql
-- pick a NEW strong password (not the same as POSTGRES_PASSWORD)
ALTER ROLE framecomment_app LOGIN PASSWORD '<STRONG-NEW-PASSWORD>';
```

Sanity-check the role is NOT privileged (all three must be `f`):

```sql
SELECT rolname, rolsuper, rolbypassrls, rolcreaterole
FROM pg_roles WHERE rolname = 'framecomment_app';
```

## 2. Set the two env vars

In the `.env` used by `docker-compose.truenas.yml`, add:

```dotenv
# app now connects as the RLS-bound role:
APP_DATABASE_URL=postgresql://framecomment_app:<STRONG-NEW-PASSWORD>@framecomment-postgres:5432/framecomment?schema=public

# migrations at boot + audited resolver lookups keep the admin role:
DATABASE_URL_PRIVILEGED=postgresql://framecomment:<POSTGRES_PASSWORD>@framecomment-postgres:5432/framecomment?schema=public
```

Nothing else changes. The worker service ignores both (it stays on the admin
URL by design — it processes jobs across companies with explicit org IDs).

## 3. Restart the app container

Recreate/restart only `framecomment-app` (TrueNAS: update the custom app /
`docker compose up -d app`). Watch the logs for:

```
[DB]  Running Prisma migrations...
      (using privileged database role for migrations)
[OK] Database migrations completed
```

## 4. Verify (in order)

1. **Login** with your account → dashboard loads, projects all there.
2. **Upload** a small video → processes to READY (worker unaffected).
3. **Open an existing share link** in incognito → loads; leave a comment.
4. **Open a short link** (`/s/<slug>`) → redirects correctly.
5. **Isolation proof** — sign in as the TEST company: it must now see **zero**
   of your projects/videos/settings (this is the moment app-level isolation
   becomes DB-enforced). Create a project there → invisible to your org.
6. **psql proof** (optional but satisfying):

   ```sql
   SET ROLE framecomment_app;
   SELECT count(*) FROM "Project";   -- 0 rows: no org context armed
   RESET ROLE;
   SELECT count(*) FROM "Project";   -- real count as admin
   ```

## 5. Rollback (30 seconds)

Delete (or comment out) `APP_DATABASE_URL` and `DATABASE_URL_PRIVILEGED` from
`.env`, restart the app container — it reconnects as the superuser exactly as
before the flip. No schema or data changes are involved in either direction.

## Notes

- `set_config('app.current_organization_id', …, true)` is transaction-scoped:
  the db.ts client extension arms it per operation; interactive transactions
  arm it as their first statement. No context → policies deny by default.
- The privileged client (`prismaPrivileged`) is used ONLY for: auth token/email
  → user, share/folder/short-link/calendar slug → org, passkey pre-auth
  lookups, boot seed, and instance-level settings reads on pre-auth paths.
  Everything else runs RLS-bound after the flip.
- Migrations always need the admin role (ALTER TABLE, policies) — the
  entrypoint switches automatically when `DATABASE_URL_PRIVILEGED` is set.
