# Security centre

The founder area's **Security** tab answers two questions that get asked in
every due-diligence conversation, and answers them with live data rather than a
claim:

1. **Who is trying to get in?** Every authentication attempt against this
   installation, with origin, what was tried, and whether it worked.
2. **Is this installation configured to resist them?** A twelve-stage scan that
   reads real state — a database setting, an environment variable, a file on
   disk — and reports the observed value alongside the fix.

---

## What is recorded

Rows land in `AccessAttempt` from the authentication paths:

| Kind | When |
| --- | --- |
| `LOGIN_SUCCESS` | An admin signs in |
| `LOGIN_FAILED` | Credentials rejected |
| `LOGIN_LOCKED` | Repeated failures triggered the lockout |
| `TOKEN_REPLAY` | A refresh token was refused — replayed, or from a device it was not issued to |

**Successes are recorded as well as failures.** "A sign-in from a country you
have never worked from" is only visible if successes are there too, and
"how would you know if you were breached?" deserves a better answer than
"we log the failures".

### What is deliberately NOT recorded

- **Passwords, in any form.** Not hashed, not truncated, not on failure. A
  breach of this table must not be a breach of anyone's credentials.
- **The raw User-Agent.** Only the coarse `browser:os` signature, which is
  enough to tell a scripted client from a person and useless for tracking
  someone across sites.

### Retention

IP addresses are personal data under GDPR. Records are deleted after
`ACCESS_LOG_RETENTION_DAYS` days (default **90**), by the worker, on startup
and every six hours. Aggregate counts survive the purge — "1,412 attempts from
Nigeria" identifies nobody.

A stated retention policy that nothing enforces is worse than no policy: it is
a claim made to customers while quietly keeping the data forever. The scan's
`privacy.purged` check exists to catch exactly that, by failing when rows older
than the window are still present.

---

## Geolocation

Resolved **locally**, from a MaxMind GeoLite2 database on disk. Nothing is sent
anywhere.

The obvious alternative — an HTTP call to ip-api or ipinfo — would ship a
visitor's IP to a third party on every lookup. Under GDPR that is a transfer of
personal data to a processor you must name in your privacy policy and sign a
DPA with, for the privilege of drawing a flag. It would also break air-gapped
installs and rate-limit under exactly the traffic spike most worth measuring.

### Setup

1. Create a free account at <https://www.maxmind.com/en/geolite2/signup> and
   generate a licence key.
2. Download `GeoLite2-City.mmdb` (and optionally `GeoLite2-ASN.mmdb`).
3. Mount them where the app can read them:

   ```yaml
   # docker-compose.yml
   services:
     app:
       volumes:
         - ./geoip:/app/geoip:ro
       environment:
         GEOIP_DB_DIR: /app/geoip   # this is the default
   ```

4. Refresh monthly. MaxMind publishes updates on Tuesdays; a stale database
   drifts, it does not break.

**Without a database**, country data still arrives for installations behind
Cloudflare, from the `CF-IPCountry` header. Without either, rows are stored with
no country and the UI shows the address without a flag. The page degrades; it
never fails.

---

## The scan

Twelve stages. Wordfence's scan is the model — its stage strip is the shape
people recognise — but the stages themselves are **not** copied. Half of
Wordfence's are WordPress problems ("Spamvertising", scanning PHP for injected
`eval()`) that cannot occur in a compiled Next.js app running from an immutable
container image. Shipping those names with nothing behind them would be
theatre, and the first technical advisor an investor brings along would find
the empty checks in a minute — which damages trust more than not having the
page at all.

| Stage | What it actually reads |
| --- | --- |
| Server state | Postgres and Redis round-trip times, worker heartbeat age, unfinished migrations |
| Transport | `APP_URL` scheme, and the refresh cookie's HttpOnly / SameSite / path flags in source |
| Secrets | Length **and Shannon entropy** of each signing key, that they are distinct, that none appears in a committed file |
| Tenant isolation | `pg_class.relrowsecurity` and `relforcerowsecurity` for every table with `organizationId`; whether the app connects as a superuser |
| Sessions | Access-token TTL, absolute cap, replay detection present, idle window within the refresh lifetime |
| Accounts | Password hash prefixes, owner count, dormant accounts, expired invitations |
| Data exposure | Projects shared without a password, links that never expire, source maps in `.next/static` |
| File integrity | SHA-256 of shipped files against the build manifest |
| Content safety | Comment sanitisation still wired to `dangerouslySetInnerHTML`; attachments with executable extensions |
| Dependencies | The `npm audit` result recorded at build time |
| Mail reputation | SPF and DMARC records for the app domain |
| Privacy | Retention configured, geolocation local, purge keeping up |

### Two checks that need build-time artefacts

`scripts/build-security-artifacts.mjs` runs during the Docker build and writes:

- `.integrity-manifest.json` — SHA-256 of every shipped file. At runtime the
  scan re-hashes and compares. Inside a container nothing should ever differ:
  the image is immutable, so a changed file means someone has a shell in the
  running container.
- `.audit-report.json` — what `npm audit` said when the image was built. The
  honest claim is "these were the known vulnerabilities in this build", not a
  live query from production to the npm registry.

Without them, those two stages report **SKIPPED** with the reason. A check that
could not run must never look like a check that passed — that distinction is
the difference between a scan and a badge.

### The score

Weighted, so a single critical failure cannot hide under twenty passing checks,
which is the failure mode of every "97% secure" badge. Skipped checks are
excluded from the calculation rather than counted as passes.

It exists so there is one number for a slide. The findings underneath are the
thing that matters, and each carries the observed value and what to do about it.
