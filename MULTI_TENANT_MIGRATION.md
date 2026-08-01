# FrameComment — Multi‑Tenant Migration Blueprint

Turning FrameComment from a single‑tenant instance into a public multi‑tenant SaaS
where anyone can register a **company (Organization)**, becomes its **OWNER**, and invites
team members — with **hard data isolation** between organizations.

Decisions locked in with the owner:

1. **Existing data → Organization #1.** Everything that exists today (users, projects,
   videos, folders, comments, settings, billing) is migrated into one default
   Organization owned by the current owner. Zero data loss.
2. **Single domain.** Everyone uses `framecomment.com`, registers / signs in, and sees
   **only their own organization**. No per‑company subdomains.
3. **Per‑company billing in this update.** Each organization has its own Stripe
   customer / card, built on top of the existing usage‑based billing.
4. **Platform "break‑glass" support access.** A platform admin (owner only) can access an
   organization for support, but only: time‑boxed, MFA‑protected, **read‑only by default**,
   requires client approval **or** a justified emergency, mandatory reason, auto‑expiry,
   and every access/change written to an **immutable audit log visible to the client**.

Naming note: the code already uses `ClientCompany` for the *client directory* (the brands
you share videos WITH). To avoid a clash, the **tenant** model is called **`Organization`**
in code; the UI still says "company".

---

## 1. Tenancy model — shared database, row‑level isolation, enforced by Postgres RLS

Shared Postgres DB. Every tenant‑owned row carries an `organizationId`. Isolation is
enforced at **two layers** (defense in depth):

- **App layer:** every query filters by the caller's `organizationId`.
- **Database layer (the real guarantee):** Postgres **Row‑Level Security (RLS)**. Even if an
  app query forgets a filter — or someone crafts a malicious id in a URL — the database
  returns **nothing** from another org. The app already ships the plumbing: `db.ts`
  sets `app.current_user_id` / `app.current_user_role` via `set_config`. We add
  `app.current_organization_id`, set it on **every** request, and add RLS policies +
  `FORCE ROW LEVEL SECURITY` on every tenant table.

RLS policy shape (per tenant table):

```sql
ALTER TABLE "Project" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Project" FORCE  ROW LEVEL SECURITY;   -- applies even to the table owner
CREATE POLICY org_isolation ON "Project"
  USING      ("organizationId" = current_setting('app.current_organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));
```

`USING` blocks reads of other orgs; `WITH CHECK` blocks writing rows into another org.
A dedicated **platform/superuser bypass** (see §7) is the only way to cross the boundary,
and only under the break‑glass rules.

Connection detail: RLS `current_setting` is per‑session. Because Prisma pools connections,
we set the org context **per request** (transaction‑scoped `set_config(..., true)`), the
same pattern `setDatabaseUserContext` already uses. This is verified in Phase 1.

---

## 2. Schema changes

### New models

```prisma
model Organization {
  id            String   @id @default(cuid())
  name          String                     // company/brand name shown in UI
  slug          String   @unique            // stable public handle
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  // Lifecycle: ACTIVE | SUSPENDED (billing) | DELETED (soft)
  status        String   @default("ACTIVE")

  users         User[]
  projects      Project[]
  // …back‑relations for every tenant model…
  settings      Settings?                  // one settings row per org
  supportGrants SupportAccessGrant[]
}
```

- **User** gains `organizationId` (a user belongs to exactly one org) + membership role
  stays the existing `UserRole`. `email` uniqueness moves from **global** to
  **`@@unique([organizationId, email])`** so the same person can exist in two different
  companies. A separate **platform admin** identity lives outside orgs (see §7).

### `organizationId` added to every tenant‑owned model

Project, Folder, FolderDocument, Video, VideoAsset, ProjectUpload, Comment, Marker,
CommentReaction, Notification, NotificationQueue, NotificationDestination /
Subscription / DeliveryLog, BillingSnapshot, SecuritySettings, SecurityEvent, BlockedIP,
BlockedDomain, VideoAnalytics, SharePageAccess, PasskeyCredential, PushSubscription,
EmailTemplate, ClientCompany, ClientContact, CalendarToken, ShortLink, OwnershipTransfer,
and **Settings** (which stops being the `id:'default'` singleton and becomes one row per org).

Each gets `@@index([organizationId, …])` on its hot query paths.

### Break‑glass models (Phase 6)

```prisma
model SupportAccessGrant {
  id             String    @id @default(cuid())
  organizationId String
  platformUserId String                     // which platform admin
  reason         String                     // mandatory justification
  mode           String    @default("READ_ONLY")  // READ_ONLY | READ_WRITE
  approvedByClient Boolean @default(false)   // client approved, or…
  emergency      Boolean   @default(false)   // …justified emergency
  createdAt      DateTime  @default(now())
  expiresAt      DateTime                    // auto‑expiry (short, e.g. ≤2h)
  revokedAt      DateTime?
}

model SupportAccessLog {              // append‑only, client‑visible
  id             String   @id @default(cuid())
  grantId        String
  organizationId String
  platformUserId String
  action         String                      // ROUTE/READ/WRITE + target
  detail         String?
  at             DateTime @default(now())
}
```

Immutability: no UPDATE/DELETE policy is ever granted on `SupportAccessLog`; only INSERT
+ the client's own SELECT.

---

## 3. Migration & backfill (existing data → Organization #1)

One migration, in order, so nothing is ever orphaned or briefly visible cross‑org:

1. Create `Organization` (+ support tables).
2. Insert the **default org** (name from current `Settings.companyName`, slug e.g. `org-1`).
3. Add `organizationId` as **nullable** to every tenant table.
4. **Backfill** every existing row's `organizationId = <default org id>`.
5. Convert `Settings(id:'default')` into that org's settings row (set its `organizationId`).
6. Change `User.email` uniqueness to `@@unique([organizationId, email])`.
7. Set `organizationId` **NOT NULL** where appropriate.
8. **Enable + FORCE RLS** and create the `org_isolation` policies on every tenant table.

Runs automatically on deploy via the existing `prisma migrate deploy` entrypoint.

---

## 4. Auth, registration & session

- **Public landing:** unauthenticated users see **Register / Sign in** (today it's login‑only).
- **`POST /api/auth/register`:** creates an `Organization` + the first user as **OWNER** in a
  single transaction, then issues tokens. Rate‑limited + email‑verification‑ready.
- **JWT** access/refresh tokens gain an `organizationId` claim. `getCurrentUserFromRequest`
  returns it; a request wrapper sets `app.current_organization_id` (like the existing
  user‑context call) so RLS is armed for the whole request.
- **Login** resolves the user within their org; the token carries the org.

---

## 5. Every route scoped

`requireApiAdmin` (and the stricter guards) already return the authenticated user; they will
additionally **set the org RLS context** and expose `organizationId`. Each route adds
`organizationId: user.organizationId` to its `where`/`create`. RLS is the backstop if one is
missed. Dual‑auth (share‑token) routes resolve the org from the **share token**, never from a
user‑supplied id.

---

## 6. Storage & share‑link isolation

- **Storage paths** are prefixed with the org: `orgs/<organizationId>/projects/<id>/…`.
  A signed content token encodes the `organizationId`; the content route verifies the token's
  org matches the resolved resource's org before streaming a byte.
- **Share tokens** already carry `projectId`/`folderId`; they gain `organizationId` and the
  share routes verify the requested resource lives in that org. **A share link minted by
  company A can never resolve company B's content**, even if ids are swapped in the URL —
  the token's org + RLS both reject it.

---

## 7. Platform admin & break‑glass support access (Phase 6)

- A **platform admin** identity (you) lives outside any org. Normal app connections run with
  RLS enforced and cannot see across orgs.
- To support a client, the platform admin opens a **SupportAccessGrant**: mandatory reason,
  READ_ONLY by default, requires client approval **or** a flagged emergency, MFA re‑check,
  short auto‑expiry. Only an **active, unexpired** grant lets the request set the target
  org context (still read‑only unless the grant is READ_WRITE).
- Every request under a grant appends to `SupportAccessLog` (append‑only, client‑visible in
  their Settings → "Support access history"). Nothing is silent.

---

## 8. Per‑company billing (Phase 5)

`Settings` becomes per‑org, so `stripeCustomerId`, card, `billingStatus`, dunning, and the
usage snapshots all become per‑org. The monthly worker iterates orgs. The billing wall
(already server‑enforced) reads the caller's org. Free‑tier + suspension are per‑org.

---

## 9. Phase plan (each phase: implement → `tsc --noEmit` + build → verify → ship)

| Phase | Scope | Risk |
|------|-------|------|
| **1** | `Organization` model, `organizationId` on all models, backfill → Org #1, RLS policies + context helper | High (live schema) |
| **2** | Register page + `/api/auth/register`, JWT `organizationId`, per‑request org context | Med |
| **3** | Scope every API route; storage path prefixing; share‑token org verification | High (breadth) |
| **4** | Invite team members within the org | Low |
| **5** | Per‑company billing (Stripe per org) | Med |
| **6** | Platform break‑glass support access (MFA, approval, expiry, immutable log) | Med |

Each phase is a separate, verified, shippable step. We do **not** flip everything at once.

---

## 10. Decisions — LOCKED (owner answered)

1. **Email verification**: yes, but non‑blocking — users can use the app while unverified.
   Ships AFTER the multi‑tenant migration is stable (platform SMTP via env, not per‑org SMTP).
2. **Company name**: asked at register (free text), editable later in Settings. Slug auto‑generated.
3. **Free tier**: 1 user / 10 GB per organization (same as today).
4. **MFA**: foundations laid now (schema/hooks), full implementation later.
5. **Invites**: in‑app generated invite LINK for now; e‑mail invites once SMTP exists.
6. **DB role**: app+worker will move to a NON‑superuser role (`framecomment_app`) so RLS is
   actually enforced (Postgres superusers bypass RLS). The migration creates the role
   NOLOGIN + grants; the operator sets its password + updates DATABASE_URL on TrueNAS when
   we flip (documented step). Until the flip, the app runs unchanged (superuser bypasses
   the new policies — zero behavioral change while we wire org context everywhere).
   The WORKER may stay on the privileged role permanently (trusted internal code that
   processes jobs across orgs).
7. **Register**: private beta first — an invite code from env (`REGISTER_INVITE_CODE`)
   gates public registration until we open it up.
8. **Test env**: owner runs a local instance (localhost:3000 / 192.168.50.196:3000);
   every phase is tested there (`npx prisma migrate deploy` locally) before live.

## 11. Phase‑1 staging trick (zero‑downtime)

Phase 1 adds `organizationId` everywhere with a temporary **DB default of `org-1`**
(the default organization). Legacy code that doesn't yet pass `organizationId` keeps
working — new rows land in org‑1, which is correct while org‑1 is the only tenant.
Phases 2–3 make every create explicit, then a cleanup migration drops the defaults and
sets NOT NULL. **Register stays closed until Phase 3 (full scoping) is complete**, so no
second tenant can exist while any code path still relies on the default.
