/**
 * 6.18.0 — the security scan.
 *
 * Wordfence's scan is the model, and its stage strip is the shape people
 * recognise. What it is NOT is a template to copy verbatim: half of those
 * stages are WordPress problems ("Spamvertising", scanning PHP for injected
 * eval()) that cannot occur in a compiled Next.js app running from an
 * immutable container image. Shipping those names with nothing behind them
 * would be theatre, and the first technical advisor an investor brings along
 * would find the empty checks in about a minute — which is worse for trust
 * than not having the page at all.
 *
 * So every stage below maps a Wordfence concern onto something that is
 * genuinely true or false about THIS system, and every check reads real state:
 * a database setting, an environment variable, a file on disk, a row count.
 * Nothing returns a constant. A check that cannot run says SKIPPED and says
 * why, rather than passing.
 *
 * The score is derived, not chosen: failures cost more than warnings, and
 * criticals cost most. It exists so there is one number for a slide, but the
 * findings underneath are the thing that matters, and each one carries the
 * observed value and what to do about it.
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import dns from 'dns/promises'
import { prismaPrivileged } from './db'
import { getRedis } from './redis'
import { geoipStatus } from './geoip'
import { ACCESS_RETENTION_DAYS } from './access-log'
import { logError } from './logging'

export type FindingStatus = 'PASS' | 'WARN' | 'FAIL' | 'SKIPPED'
export type FindingSeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export interface Finding {
  stage: string
  checkId: string
  title: string
  status: FindingStatus
  severity: FindingSeverity
  /** The observed value — the thing that made this pass or fail. */
  detail?: string
  /** What to type to fix it. */
  remediation?: string
  /**
   * 6.19.0 — what this means, for someone who is not an engineer.
   *
   * `detail` and `remediation` both assume the reader already knows why the
   * check exists. This is the sentence in between: what could actually go
   * wrong, in plain words. Without it a findings list is a set of orders to
   * obey rather than a situation to understand — and the person deciding what
   * to fix first is precisely the person it was written past.
   */
  impact?: string
}

export interface ScanStage {
  id: string
  label: string
  /** One line explaining what this stage is actually looking at. */
  blurb: string
  /**
   * 6.20.0 — is this stage worth running EVERY day?
   *
   * The split is not "important vs unimportant"; every stage here matters.
   * It is "can this change without a deploy?".
   *
   * A dependency advisory, a modified file, a missing DMARC record: none of
   * those can become true between two deploys of the same image, so checking
   * them daily is noise that costs DNS lookups and a full directory hash. A
   * worker that died overnight, an RLS policy someone altered, a share link a
   * colleague made public this afternoon, a purge job that stopped: those are
   * exactly the things that go wrong while nobody is deploying.
   *
   * So the daily run is the subset that can change underneath you, and the
   * weekly run is everything.
   */
  daily: boolean
  run: () => Promise<Finding[]>
}

const ok = (
  stage: string,
  checkId: string,
  title: string,
  detail?: string,
): Finding => ({ stage, checkId, title, status: 'PASS', severity: 'INFO', detail })

const warn = (
  stage: string,
  checkId: string,
  title: string,
  detail: string,
  remediation: string,
  severity: FindingSeverity = 'MEDIUM',
  impact?: string,
): Finding => ({ stage, checkId, title, status: 'WARN', severity, detail, remediation, impact })

const fail = (
  stage: string,
  checkId: string,
  title: string,
  detail: string,
  remediation: string,
  severity: FindingSeverity = 'HIGH',
  impact?: string,
): Finding => ({ stage, checkId, title, status: 'FAIL', severity, detail, remediation, impact })

const skip = (
  stage: string,
  checkId: string,
  title: string,
  detail: string,
): Finding => ({ stage, checkId, title, status: 'SKIPPED', severity: 'INFO', detail })

/**
 * Shannon entropy in bits for the whole string. A 64-character secret made of
 * one repeated character is 64 characters long and worthless; length alone is
 * the wrong test, and it is the test most people ship.
 */
function entropyBits(value: string): number {
  if (!value) return 0
  const counts = new Map<string, number>()
  for (const ch of value) counts.set(ch, (counts.get(ch) || 0) + 1)
  let bitsPerChar = 0
  for (const n of counts.values()) {
    const p = n / value.length
    bitsPerChar -= p * Math.log2(p)
  }
  return bitsPerChar * value.length
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Server state
// ─────────────────────────────────────────────────────────────────────────────
async function stageServer(): Promise<Finding[]> {
  const s = 'server'
  const out: Finding[] = []

  try {
    const started = Date.now()
    await prismaPrivileged.$queryRawUnsafe('SELECT 1')
    const ms = Date.now() - started
    out.push(
      ms > 500
        ? warn(s, 'db.reachable', 'Database is slow to respond', `Answered in ${ms}ms`,
            'A slow database makes every request slow. Check load and connection pooling.', 'LOW',
            'The site will feel sluggish for everyone. Not a security hole, but slow systems are the ones people disable protections on.')
        : ok(s, 'db.reachable', 'Database responds', `Answered in ${ms}ms`),
    )
  } catch (error) {
    out.push(fail(s, 'db.reachable', 'Database did not respond', String(error),
      'The application cannot serve anything without Postgres. Check the container and DATABASE_URL.', 'CRITICAL',
      'Nothing works at all — no logins, no video, no comments. This is an outage, not a warning.'))
  }

  try {
    const started = Date.now()
    await getRedis().ping()
    out.push(ok(s, 'redis.reachable', 'Redis responds', `Answered in ${Date.now() - started}ms`))
  } catch (error) {
    out.push(fail(s, 'redis.reachable', 'Redis did not respond', String(error),
      'Redis holds the revocation list, rate limits and job queue. Without it, revoked sessions may keep working.', 'CRITICAL',
      'Someone you just signed out could still be signed in, and the brute-force protection on the login page stops counting.'))
  }

  try {
    const beats: Array<{ service: string; lastSeenAt: Date }> =
      await (prismaPrivileged as any).serviceHeartbeat.findMany()
    const worker = beats.find((b) => b.service.toLowerCase().includes('worker'))
    if (!worker) {
      out.push(warn(s, 'worker.alive', 'Encoding worker has never reported in', 'No heartbeat recorded',
        'Uploads will never finish encoding. Check the worker container.', 'HIGH',
        'Clients upload a video and it stays stuck forever. They will assume the product is broken, and they will be right.'))
    } else {
      const ageMin = Math.round((Date.now() - new Date(worker.lastSeenAt).getTime()) / 60000)
      out.push(
        ageMin > 5
          ? fail(s, 'worker.alive', 'Encoding worker has stopped reporting', `Last heartbeat ${ageMin} minutes ago`,
              'The worker has stopped. Videos will upload but never encode.', 'HIGH',
              'Clients upload a video and it stays stuck forever. They will assume the product is broken, and they will be right.')
          : ok(s, 'worker.alive', 'Encoding worker is alive', `Last heartbeat ${ageMin} minutes ago`),
      )
    }
  } catch {
    out.push(skip(s, 'worker.alive', 'Encoding worker is alive', 'Heartbeat table not available'))
  }

  // Migrations: a container running old code against a new schema, or the
  // reverse, is the failure mode that produces the strangest bug reports.
  try {
    const rows: Array<{ count: bigint }> = await prismaPrivileged.$queryRawUnsafe(
      `SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NULL`,
    )
    const pending = Number(rows?.[0]?.count ?? 0)
    out.push(
      pending > 0
        ? fail(s, 'db.migrations', 'Migrations are unfinished', `${pending} migration(s) unfinished`,
            'Restart the app container; the entrypoint applies migrations on boot.', 'HIGH',
            'The code expects a database shape the database does not have yet. Expect strange errors in random places until it catches up.')
        : ok(s, 'db.migrations', 'All migrations applied', 'No unfinished migrations'),
    )
  } catch {
    out.push(skip(s, 'db.migrations', 'All migrations applied', 'Migration table not readable'))
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Transport security
// ─────────────────────────────────────────────────────────────────────────────
/**
 * The address the application actually publishes itself at, and where that
 * answer came from.
 *
 * 6.23.0 — extracted, because having it in one stage and a different, wrong
 * version in another is precisely how the bug happened. 6.20.1 fixed the
 * transport check to read `Settings.appDomain` the way `lib/url.ts` does, and
 * left the mail stage reading NEXT_PUBLIC_APP_URL — an environment variable
 * this app does not consult. So on a correctly configured production the mail
 * stage concluded there was no domain and skipped, while the transport stage
 * three sections earlier reported the domain by name.
 *
 * Environment first (an operator who sets it means it), then the setting.
 */
async function resolveAppUrl(): Promise<{ url: string; source: string }> {
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || ''
  if (fromEnv) return { url: fromEnv, source: 'environment' }
  try {
    const rows: Array<{ appDomain: string | null }> = await prismaPrivileged.$queryRawUnsafe(
      `SELECT "appDomain" FROM "Settings" WHERE "appDomain" IS NOT NULL AND "appDomain" <> '' LIMIT 1`,
    )
    if (rows?.[0]?.appDomain) return { url: rows[0].appDomain, source: 'app settings' }
  } catch {
    // Settings unreadable — the honest answer is "we cannot tell", which the
    // callers render as a warning or a skip rather than a pass.
  }
  return { url: '', source: 'nowhere' }
}

async function stageTransport(): Promise<Finding[]> {
  const s = 'transport'
  const out: Finding[] = []
  /*
   * 6.20.1 — ask the same question the app asks.
   *
   * The previous version only read NEXT_PUBLIC_APP_URL and warned when it was
   * unset. But `lib/url.ts` resolves the public address from the `appDomain`
   * setting in the database FIRST, and falls back to the request headers.
   * Warning about an environment variable the app does not consult produced a
   * finding nobody could act on correctly: setting the variable would not have
   * changed anything, and the actual configuration was fine.
   */
  const { url: appUrl, source } = await resolveAppUrl()

  if (!appUrl) {
    out.push(warn(s, 'https.url', 'No public address configured',
      'No public address configured in settings or environment',
      'Set the app domain in Settings, or NEXT_PUBLIC_APP_URL, so links are absolute rather than derived from whichever host the request arrived on.', 'MEDIUM',
      'Share links are built from the address the browser happened to use. Usually right, but a proxy misconfiguration would send clients somewhere wrong.'))
  } else {
    out.push(
      appUrl.startsWith('https://')
        ? ok(s, 'https.url', 'Public URL is HTTPS', `${appUrl} (from ${source})`)
        : fail(s, 'https.url', 'Public URL is not HTTPS', appUrl,
            'Over plain HTTP the session cookie cannot be Secure and every token crosses the network in the clear.', 'CRITICAL',
            'Anyone on the same wifi as one of your users could read their session and sign in as them. This is the single worst thing on this list.'),
    )
  }

  // The refresh cookie's flags are set in code, not config — so this verifies
  // the code has not regressed, which is exactly what a scan is for.
  try {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/lib/auth-cookies.ts'), 'utf8',
    )
    const hasHttpOnly = /httpOnly:\s*true/.test(source)
    const hasStrict = /sameSite:\s*'strict'/.test(source)
    const scoped = /path:\s*REFRESH_COOKIE_PATH/.test(source)
    const allGood = hasHttpOnly && hasStrict && scoped
    out.push(
      allGood
        ? ok(s, 'cookie.flags', 'Refresh cookie is hardened', 'HttpOnly, SameSite=Strict, path-scoped to /api/auth')
        : fail(s, 'cookie.flags', 'Refresh cookie is missing protections',
            `HttpOnly=${hasHttpOnly} SameSite=Strict=${hasStrict} scoped=${scoped}`,
            'The long-lived credential must not be readable by JavaScript or sent cross-site.', 'CRITICAL',
            'A single bad script on the page — ours or a library\u2019s — could steal a login that lasts a month.'),
    )
  } catch {
    out.push(skip(s, 'cookie.flags', 'Refresh cookie is hardened', 'Source not readable in this build'))
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Secrets
// ─────────────────────────────────────────────────────────────────────────────
async function stageSecrets(): Promise<Finding[]> {
  const s = 'secrets'
  const out: Finding[] = []

  const secrets: Array<[string, string | undefined]> = [
    ['JWT_SECRET', process.env.JWT_SECRET],
    ['JWT_REFRESH_SECRET', process.env.JWT_REFRESH_SECRET],
    ['SHARE_TOKEN_SECRET', process.env.SHARE_TOKEN_SECRET],
  ]

  for (const [name, value] of secrets) {
    const id = `secret.${name.toLowerCase()}`
    if (!value) {
      out.push(fail(s, id, `${name} is set`, 'Missing',
        'Tokens signed with a missing or empty secret are forgeable.', 'CRITICAL',
        'Anyone could hand-write a login token and walk in as any user, including you.'))
      continue
    }
    const bits = Math.round(entropyBits(value))
    // 128 bits is the usual floor for a signing key. Length alone is not the
    // test: a 64-character string of one repeated character passes a length
    // check and is worth nothing.
    if (value.length < 32 || bits < 128) {
      out.push(fail(s, id, `${name} is strong`,
        `${value.length} characters, ~${bits} bits of entropy`,
        'Generate a new one with `openssl rand -base64 48` and restart. Existing sessions will end.', 'HIGH',
        'A weak signing key can be guessed by brute force. Once guessed, someone can forge a login for any account.'))
    } else {
      out.push(ok(s, id, `${name} is strong`, `${value.length} characters, ~${bits} bits of entropy`))
    }
  }

  const present = secrets.map(([, v]) => v).filter(Boolean) as string[]
  const unique = new Set(present)
  out.push(
    unique.size === present.length
      ? ok(s, 'secret.distinct', 'Signing secrets are distinct', `${present.length} secrets, all different`)
      : fail(s, 'secret.distinct', 'Signing secrets are reused', 'Two or more secrets share a value',
          'A share token could then be presented as an admin token. Rotate them to independent values.', 'CRITICAL',
          'A client with a share link could turn it into full admin access. Sharing one key between two locks means one key opens both.'),
  )

  // A secret committed to the repository is a secret the whole internet has.
  try {
    const envExample = path.join(process.cwd(), '.env.example')
    if (fs.existsSync(envExample)) {
      const text = fs.readFileSync(envExample, 'utf8')
      const leaked = present.filter((v) => v.length > 8 && text.includes(v))
      out.push(
        leaked.length === 0
          ? ok(s, 'secret.notcommitted', 'No live secret in .env.example', 'Placeholders only')
          : fail(s, 'secret.notcommitted', 'A live secret is committed in .env.example',
              `${leaked.length} live secret(s) appear in a committed file`,
              'Rotate them immediately and replace with placeholders.', 'CRITICAL',
              'The key is in the public repository. Treat it as already known by strangers.'),
      )
    }
  } catch {
    /* not fatal */
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Tenant isolation — the one an investor should be shown first
// ─────────────────────────────────────────────────────────────────────────────
async function stageIsolation(): Promise<Finding[]> {
  const s = 'isolation'
  const out: Finding[] = []

  try {
    // Every table carrying organizationId must have row-level security both
    // ENABLED and FORCED. Enabled-but-not-forced silently exempts the table
    // owner, which is the role the app usually connects as — the isolation
    // looks configured and does nothing.
    const rows: Array<{ tablename: string; rls: boolean; forced: boolean }> =
      await prismaPrivileged.$queryRawUnsafe(`
        SELECT c.relname AS tablename,
               c.relrowsecurity  AS rls,
               c.relforcerowsecurity AS forced
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND EXISTS (
            SELECT 1 FROM information_schema.columns col
            WHERE col.table_name = c.relname
              AND col.column_name = 'organizationId'
          )
      `)

    const missing = rows.filter((r) => !r.rls)
    const unforced = rows.filter((r) => r.rls && !r.forced)

    out.push(
      rows.length === 0
        ? skip(s, 'rls.enabled', 'Row-level security on tenant tables', 'No tenant tables found')
        : missing.length === 0
          ? ok(s, 'rls.enabled', 'Row-level security on tenant tables',
              `${rows.length} tenant tables, all with RLS enabled`)
          : fail(s, 'rls.enabled', 'Tenant tables without row-level security',
              `${missing.length} of ${rows.length} without RLS: ${missing.slice(0, 5).map((r) => r.tablename).join(', ')}`,
              'One company could read another\'s rows. Enable RLS on these tables.', 'CRITICAL',
              'One customer could see another customer\u2019s videos and comments. For a multi-tenant product this is the finding that ends the conversation.'),
    )

    if (rows.length > 0) {
      out.push(
        unforced.length === 0
          ? ok(s, 'rls.forced', 'Row-level security is FORCED', 'No table exempts its owner')
          : fail(s, 'rls.forced', 'Row-level security is not forced',
              `${unforced.length} table(s) enabled but not forced: ${unforced.slice(0, 5).map((r) => r.tablename).join(', ')}`,
              'Without FORCE, the owning role bypasses every policy — which is the role the app connects as.', 'CRITICAL',
              'The separation between customers looks configured but is not applied. It would pass a glance and fail a real test.'),
      )
    }

    /*
     * Does the APPLICATION connect as a superuser? A superuser bypasses every
     * RLS policy, whatever the policies say.
     *
     * 6.20.1 — this used to ask `SELECT current_user` through
     * `prismaPrivileged`, which is the wrong client to ask. That client exists
     * precisely to hold the admin role: it runs migrations and the cross-org
     * reads this scan itself depends on. Asking it whether it is privileged
     * always answers yes, so the check reported CRITICAL on a correctly
     * configured production system — the single most alarming line in the
     * report, and it was measuring the wrong thing.
     *
     * The role that matters is the one in DATABASE_URL, which is what every
     * customer-facing query uses. We read the name from there and ask Postgres
     * about that role by name, so the answer does not depend on which
     * connection asks the question.
     */
    let appRole = ''
    try {
      const url = process.env.DATABASE_URL || ''
      appRole = url ? decodeURIComponent(new URL(url).username || '') : ''
    } catch {
      appRole = ''
    }

    if (!appRole) {
      out.push(skip(s, 'rls.notsuperuser', 'Application connects as a non-superuser',
        'Could not read the role name from DATABASE_URL'))
    } else {
      const su: Array<{ usesuper: boolean }> = await prismaPrivileged.$queryRawUnsafe(
        `SELECT usesuper FROM pg_user WHERE usename = $1`, appRole,
      )
      if (su.length === 0) {
        out.push(warn(s, 'rls.notsuperuser', 'Could not confirm the database role',
          `Role "${appRole}" not found in pg_user`,
          'Check DATABASE_URL matches an existing role.', 'MEDIUM',
          'The check could not confirm which permissions the application runs with.'))
      } else {
        out.push(
          su[0].usesuper
            ? fail(s, 'rls.notsuperuser', 'Application connects as a superuser',
                `The application connects as "${appRole}", which is a superuser`,
                'A superuser bypasses every RLS policy. Point DATABASE_URL at a dedicated non-superuser role.', 'CRITICAL',
                'Every wall between customers is ignored on this connection. A bug in one query could return another company\u2019s data.')
            : ok(s, 'rls.notsuperuser', 'Application connects as a non-superuser',
                `The application connects as "${appRole}" (not a superuser)`),
        )
      }
    }
  } catch (error) {
    out.push(skip(s, 'rls.enabled', 'Row-level security on tenant tables',
      `Could not inspect: ${String(error).slice(0, 120)}`))
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Session hygiene
// ─────────────────────────────────────────────────────────────────────────────
async function stageSessions(): Promise<Finding[]> {
  const s = 'sessions'
  const out: Finding[] = []

  const accessTtl = Number.parseInt(process.env.ADMIN_ACCESS_TTL_SECONDS || '900', 10)
  out.push(
    accessTtl <= 3600
      ? ok(s, 'session.accessttl', 'Access token is short-lived', `${Math.round(accessTtl / 60)} minutes`)
      : warn(s, 'session.accessttl', 'Access token lives longer than it should', `${Math.round(accessTtl / 60)} minutes`,
          'A stolen access token stays usable for this long — it cannot be revoked before it expires.', 'MEDIUM',
          'If a token leaks, signing the person out does not stop it. It keeps working until it expires on its own.'),
  )

  const absolute = Number.parseInt(
    process.env.ADMIN_ABSOLUTE_SESSION_SECONDS || String(30 * 24 * 3600), 10,
  )
  out.push(
    absolute > 0 && absolute <= 90 * 24 * 3600
      ? ok(s, 'session.absolute', 'Sessions have an absolute cap', `${Math.round(absolute / 86400)} days`)
      : fail(s, 'session.absolute', 'Sessions have no absolute cap',
          absolute > 0 ? `${Math.round(absolute / 86400)} days` : 'Disabled',
          'Without a cap, a session kept alive by refreshes never ends.', 'HIGH',
          'A stolen session could stay valid forever as long as it keeps being used. There would be no point at which it simply dies.'),
  )

  try {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/auth.ts'), 'utf8')
    out.push(
      /isReplayedRefreshToken/.test(source) && /revokeTokenFamily/.test(source)
        ? ok(s, 'session.replay', 'Refresh-token replay is detected', 'Rotation with reuse detection is active')
        : fail(s, 'session.replay', 'Refresh-token replay goes undetected', 'Not found in the auth layer',
            'Without reuse detection, rotation is decorative: a stolen token rotates alongside the victim.', 'HIGH',
            'A thief with a copy of a session would keep renewing it in step with the real user, and nothing would notice.'),
    )
  } catch {
    out.push(skip(s, 'session.replay', 'Refresh-token replay is detected', 'Source not readable'))
  }

  try {
    const settings: Array<{ adminSessionTimeoutValue: number; adminSessionTimeoutUnit: string }> =
      await prismaPrivileged.$queryRawUnsafe(
        `SELECT "adminSessionTimeoutValue", "adminSessionTimeoutUnit" FROM "SecuritySettings"`,
      )
    const hours = settings.map((r) =>
      r.adminSessionTimeoutUnit === 'HOURS' ? r.adminSessionTimeoutValue : r.adminSessionTimeoutValue / 60,
    )
    const worst = hours.length ? Math.max(...hours) : 0
    out.push(
      worst <= 720
        ? ok(s, 'session.idle', 'Idle timeout within the refresh window', `Longest configured: ${Math.round(worst)}h`)
        : warn(s, 'session.idle', 'Idle timeout outstays the refresh window', `Longest configured: ${Math.round(worst)}h`,
            'An idle window longer than the refresh-token lifetime is a promise the auth layer cannot keep.', 'LOW',
            'People will be signed out earlier than the setting says. Confusing, not dangerous.'),
    )
  } catch {
    out.push(skip(s, 'session.idle', 'Idle timeout within the refresh window', 'Settings not readable'))
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Accounts and access
// ─────────────────────────────────────────────────────────────────────────────
async function stageAccounts(): Promise<Finding[]> {
  const s = 'accounts'
  const out: Finding[] = []

  try {
    const users: Array<{
      id: string; email: string | null; role: string | null; createdAt: Date; password: string | null
    }> = await prismaPrivileged.$queryRawUnsafe(
      `SELECT id, email, role, "createdAt", password FROM "User"`,
    )

    // bcrypt/argon prefixes. A password column that is not one of these is
    // either plaintext or a hash nobody should be using in 2026.
    const unhashed = users.filter(
      (u) => u.password && !/^\$(2[aby]|argon2|scrypt)/.test(u.password),
    )
    out.push(
      unhashed.length === 0
        ? ok(s, 'accounts.hashing', 'All passwords are properly hashed', `${users.length} accounts checked`)
        : fail(s, 'accounts.hashing', 'Some passwords are not properly hashed',
            `${unhashed.length} account(s) without a recognised hash prefix`,
            'Force a password reset for these accounts immediately.', 'CRITICAL',
            'Passwords are stored in a form that can be read or reversed. Anyone who gets a copy of the database gets the passwords.'),
    )

    const owners = users.filter((u) => (u.role || '').toUpperCase() === 'OWNER')
    out.push(
      owners.length <= 2
        ? ok(s, 'accounts.owners', 'Owner accounts are few', `${owners.length} owner(s)`)
        : warn(s, 'accounts.owners', 'More owner accounts than necessary', `${owners.length} owners across the platform`,
            'Owner can delete a company. Grant the narrowest role that works.', 'MEDIUM',
            'Each owner can delete everything. The more people hold that, the more ways one bad day ends the business.'),
    )
  } catch (error) {
    out.push(skip(s, 'accounts.hashing', 'All passwords are properly hashed', String(error).slice(0, 120)))
  }

  // Dormant accounts are the ones nobody notices being taken over.
  try {
    const rows: Array<{ count: bigint }> = await prismaPrivileged.$queryRawUnsafe(`
      SELECT COUNT(*)::bigint AS count FROM "User" u
      WHERE NOT EXISTS (
        SELECT 1 FROM "AccessAttempt" a
        WHERE a."identifier" = u.email AND a.succeeded = true
          AND a."createdAt" > NOW() - INTERVAL '90 days'
      )
      AND u."createdAt" < NOW() - INTERVAL '90 days'
    `)
    const dormant = Number(rows?.[0]?.count ?? 0)
    out.push(
      dormant === 0
        ? ok(s, 'accounts.dormant', 'No dormant accounts', 'Every account signed in within 90 days')
        : warn(s, 'accounts.dormant', 'Dormant accounts still enabled',
            `${dormant} account(s) with no successful sign-in in 90 days`,
            'Disable accounts that are no longer used; they are the ones nobody notices being taken over.', 'MEDIUM',
            'If somebody takes over an account nobody uses, nobody notices. Unused accounts are the quietest way in.'),
    )
  } catch {
    out.push(skip(s, 'accounts.dormant', 'No dormant accounts', 'Needs 90 days of access history'))
  }

  try {
    const rows: Array<{ count: bigint }> = await prismaPrivileged.$queryRawUnsafe(
      `SELECT COUNT(*)::bigint AS count FROM "TeamInvite" WHERE "acceptedAt" IS NULL AND "expiresAt" < NOW()`,
    )
    const stale = Number(rows?.[0]?.count ?? 0)
    out.push(
      stale === 0
        ? ok(s, 'accounts.invites', 'No expired invitations left open', 'None pending')
        : warn(s, 'accounts.invites', 'Expired invitations left open', `${stale} expired invite(s) still stored`,
            'Revoke them. An invite link that leaks later is one fewer thing to worry about.', 'LOW',
            'Old invitation links sitting in inboxes. Low risk, but free to clean up.'),
    )
  } catch {
    out.push(skip(s, 'accounts.invites', 'No expired invitations left open', 'Invite table not readable'))
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Data exposure
// ─────────────────────────────────────────────────────────────────────────────
async function stageExposure(): Promise<Finding[]> {
  const s = 'exposure'
  const out: Finding[] = []

  try {
    const rows: Array<{ total: bigint; unprotected: bigint; neverexpires: bigint }> =
      await prismaPrivileged.$queryRawUnsafe(`
        SELECT COUNT(*)::bigint AS total,
               COUNT(*) FILTER (WHERE "sharePassword" IS NULL)::bigint AS unprotected,
               COUNT(*) FILTER (WHERE "shareExpiresAt" IS NULL)::bigint AS neverexpires
        FROM "Project" WHERE "deletedAt" IS NULL
      `)
    const total = Number(rows?.[0]?.total ?? 0)
    const unprotected = Number(rows?.[0]?.unprotected ?? 0)
    const never = Number(rows?.[0]?.neverexpires ?? 0)

    out.push(
      total === 0
        ? skip(s, 'exposure.password', 'Shared projects are password-protected', 'No projects yet')
        : unprotected === 0
          ? ok(s, 'exposure.password', 'Shared projects are password-protected', `${total} project(s), all protected`)
          : warn(s, 'exposure.password', 'Shared projects without a password',
              `${unprotected} of ${total} share without a password`,
              'Anyone with the link can watch. Deliberate for some clients; worth confirming it is deliberate for all of them.', 'MEDIUM',
              'If a link is forwarded, or ends up somewhere public, the footage is watchable by anyone who has it.'),
    )

    out.push(
      total === 0
        ? skip(s, 'exposure.expiry', 'Share links expire', 'No projects yet')
        : never === 0
          ? ok(s, 'exposure.expiry', 'Share links expire', 'Every project has an expiry')
          : warn(s, 'exposure.expiry', 'Share links that never expire', `${never} of ${total} never expire`,
              'A link in an old email works forever. Set an expiry on finished projects.', 'MEDIUM',
              'A client who left two years ago can still open the project from an old email.'),
    )
  } catch (error) {
    out.push(skip(s, 'exposure.password', 'Shared projects are password-protected', String(error).slice(0, 120)))
  }

  // A source map in production hands an attacker your original source.
  try {
    const staticDir = path.join(process.cwd(), '.next/static')
    if (fs.existsSync(staticDir)) {
      let maps = 0
      const walk = (dir: string, depth = 0) => {
        if (depth > 4) return
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) walk(full, depth + 1)
          else if (entry.name.endsWith('.map')) maps += 1
        }
      }
      walk(staticDir)
      out.push(
        maps === 0
          ? ok(s, 'exposure.sourcemaps', 'No source maps served in production', 'None found in .next/static')
          : warn(s, 'exposure.sourcemaps', 'Source maps served in production', `${maps} .map file(s) present`,
              'Source maps let anyone read your original source. Disable productionBrowserSourceMaps.', 'MEDIUM',
              'Anyone visiting the site can read your original code, including comments about how things work.'),
      )
    }
  } catch {
    /* build layout differs; not worth failing over */
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. File integrity
// ─────────────────────────────────────────────────────────────────────────────
async function stageFiles(): Promise<Finding[]> {
  const s = 'files'
  const out: Finding[] = []

  // Wordfence compares WordPress files against wordpress.org. The equivalent
  // here is the container image: it is built once and should never change at
  // runtime. A modified file inside a running container means someone has a
  // shell in it, which is the only interesting version of this question.
  const manifestPath = path.join(process.cwd(), '.integrity-manifest.json')
  if (!fs.existsSync(manifestPath)) {
    out.push(skip(s, 'files.manifest', 'Application files unmodified since build',
      'No build manifest — generate it during the image build (scripts/build-integrity-manifest.mjs)'))
    return out
  }

  try {
    const manifest: Record<string, string> = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const changed: string[] = []
    const missing: string[] = []
    for (const [rel, expected] of Object.entries(manifest)) {
      const full = path.join(process.cwd(), rel)
      if (!fs.existsSync(full)) { missing.push(rel); continue }
      const actual = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
      if (actual !== expected) changed.push(rel)
    }
    const problems = changed.length + missing.length
    out.push(
      problems === 0
        ? ok(s, 'files.manifest', 'Application files unmodified since build',
            `${Object.keys(manifest).length} files verified`)
        : fail(s, 'files.manifest', 'Application files changed since build',
            `${changed.length} modified, ${missing.length} missing (e.g. ${[...changed, ...missing].slice(0, 3).join(', ')})`,
            'Files inside a container should never change at runtime. Redeploy and investigate how they were written.', 'CRITICAL',
            'The running code is not the code you shipped. Either something is broken, or someone has access to the server.'),
    )
  } catch (error) {
    out.push(skip(s, 'files.manifest', 'Application files unmodified since build', String(error).slice(0, 120)))
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Content safety
// ─────────────────────────────────────────────────────────────────────────────
async function stageContent(): Promise<Finding[]> {
  const s = 'content'
  const out: Finding[] = []

  // Comment HTML is rendered with dangerouslySetInnerHTML. The only thing
  // standing between a client's comment and stored XSS is the sanitiser.
  try {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/components/MessageBubble.tsx'), 'utf8',
    )
    const sanitises = /sanitizeContent\(/.test(source)
    out.push(
      sanitises
        ? ok(s, 'content.sanitised', 'Comment HTML is sanitised before render', 'sanitizeContent() in use')
        : fail(s, 'content.sanitised', 'Comment HTML is not sanitised before render',
            'Raw HTML reaches dangerouslySetInnerHTML',
            'A client comment could then run script in a reviewer\'s session.', 'CRITICAL',
            'A client could leave a comment that runs code in your browser when you read it, and act as you.'),
    )
  } catch {
    out.push(skip(s, 'content.sanitised', 'Comment HTML is sanitised before render', 'Source not readable'))
  }

  // Executables and scripts have no business in a video review tool.
  try {
    const rows: Array<{ filename: string; count: bigint }> = await prismaPrivileged.$queryRawUnsafe(`
      SELECT "fileName" AS filename, COUNT(*)::bigint AS count
      FROM "VideoAsset"
      WHERE "fileName" ~* '\\.(php|phtml|jsp|asp|aspx|exe|sh|bat|cmd|scr|js|mjs|html?)$'
      GROUP BY "fileName" LIMIT 10
    `)
    out.push(
      rows.length === 0
        ? ok(s, 'content.extensions', 'No executable attachments stored', 'No scripts or binaries among attachments')
        : warn(s, 'content.extensions', 'Executable attachments stored',
            `${rows.length} attachment(s) with an executable extension: ${rows.slice(0, 3).map((r) => r.filename).join(', ')}`,
            'They are served as downloads, not executed — but review why they were uploaded at all.', 'MEDIUM',
            'Someone attached a program to a comment. It cannot run on the server, but ask why it is there.'),
    )
  } catch {
    out.push(skip(s, 'content.extensions', 'No executable attachments stored', 'Asset table not readable'))
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. Dependencies
// ─────────────────────────────────────────────────────────────────────────────
async function stageDependencies(): Promise<Finding[]> {
  const s = 'dependencies'
  const out: Finding[] = []

  // `npm audit` needs the registry and the lockfile, neither of which is
  // guaranteed inside a production container. The audit is run at BUILD time
  // and its result written to disk; reading that is honest about when the
  // answer was true.
  const reportPath = path.join(process.cwd(), '.audit-report.json')
  if (!fs.existsSync(reportPath)) {
    out.push(skip(s, 'deps.audit', 'No known-vulnerable dependencies',
      'No build-time audit report found — run `npm audit --json > .audit-report.json` during the image build'))
    return out
  }

  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    const v = report?.metadata?.vulnerabilities || {}
    const critical = Number(v.critical || 0)
    const high = Number(v.high || 0)
    const moderate = Number(v.moderate || 0)
    const low = Number(v.low || 0)
    const summary = `${critical} critical, ${high} high, ${moderate} moderate, ${low} low`

    out.push(
      critical > 0
        ? fail(s, 'deps.critical', 'Critical dependency vulnerabilities', summary,
            'Run `npm audit fix` and rebuild.', 'CRITICAL',
            'A third-party library you depend on has a publicly known hole. Public means attackers have the instructions too.')
        : ok(s, 'deps.critical', 'No critical dependency vulnerabilities', summary),
    )
    out.push(
      high > 0
        ? warn(s, 'deps.high', 'High-severity dependency vulnerabilities', summary,
            'Run `npm audit fix` and rebuild. Pay attention to anything that processes user input.', 'HIGH',
            'Known weaknesses in libraries you use. Not proof of a break-in, but a published map of where to try.')
        : ok(s, 'deps.high', 'No high-severity dependency vulnerabilities', summary),
    )
  } catch (error) {
    out.push(skip(s, 'deps.audit', 'No known-vulnerable dependencies', String(error).slice(0, 120)))
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Mail reputation
// ─────────────────────────────────────────────────────────────────────────────
async function stageReputation(): Promise<Finding[]> {
  const s = 'reputation'
  const out: Finding[] = []

  const { url: appUrl } = await resolveAppUrl()
  let domain = ''
  try { domain = appUrl ? new URL(appUrl).hostname : '' } catch { /* ignore */ }

  if (!domain) {
    // 6.23.0: BOTH checks report, and the reason is stated. The old early
    // return pushed a single SPF skip and left `mail.dmarc` out of the report
    // entirely — not passed, not failed, not listed as unverifiable. A check
    // that silently disappears is worse than one that says it could not run,
    // because nobody can notice the absence.
    out.push(skip(s, 'mail.spf', 'Sender policy published', 'No app domain configured'))
    out.push(skip(s, 'mail.dmarc', 'DMARC policy published', 'No app domain configured'))
    return out
  }

  // Wordfence's "Spamvertising / Blocklist" stages ask whether the site is
  // being used to send junk. The version of that question which matters here
  // is whether OUR notification mail will be delivered or silently binned —
  // an invite that lands in spam is a security control that failed quietly.
  try {
    const txt = await dns.resolveTxt(domain)
    const flat = txt.map((parts) => parts.join('')).join(' ')
    out.push(
      /v=spf1/i.test(flat)
        ? ok(s, 'mail.spf', 'Sender policy published', 'SPF record present')
        : warn(s, 'mail.spf', 'No sender policy (SPF) published', 'No SPF record on ' + domain,
            'Without SPF, invitations and password resets are likely to be filtered as spam.', 'MEDIUM',
            'Invitations and password resets will land in spam. A security email nobody reads is a security control that failed quietly.'),
    )
  } catch {
    out.push(skip(s, 'mail.spf', 'Sender policy published', `Could not query TXT for ${domain}`))
  }

  try {
    const txt = await dns.resolveTxt(`_dmarc.${domain}`)
    const flat = txt.map((parts) => parts.join('')).join(' ')
    out.push(
      /v=DMARC1/i.test(flat)
        ? ok(s, 'mail.dmarc', 'DMARC policy published', 'DMARC record present')
        : warn(s, 'mail.dmarc', 'No DMARC policy published', 'No DMARC record',
            'DMARC stops someone sending mail that claims to be from your domain.', 'MEDIUM',
            'Anyone can send email that looks like it came from you — to your clients, asking for things.'),
    )
  } catch {
    out.push(warn(s, 'mail.dmarc', 'No DMARC policy published', `No _dmarc TXT record on ${domain}`,
      'DMARC stops someone sending mail that claims to be from your domain.', 'MEDIUM',
      'Anyone can send email that looks like it came from you — to your clients, asking for things.'))
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. Privacy posture
// ─────────────────────────────────────────────────────────────────────────────
async function stagePrivacy(): Promise<Finding[]> {
  const s = 'privacy'
  const out: Finding[] = []

  out.push(
    ACCESS_RETENTION_DAYS > 0 && ACCESS_RETENTION_DAYS <= 365
      ? ok(s, 'privacy.retention', 'Access logs have a retention limit', `${ACCESS_RETENTION_DAYS} days`)
      : fail(s, 'privacy.retention', 'Access logs have no retention limit',
          ACCESS_RETENTION_DAYS > 365 ? `${ACCESS_RETENTION_DAYS} days` : 'Disabled',
          'IP addresses are personal data under GDPR. Keeping them indefinitely needs a legal basis you probably do not have.', 'HIGH',
          'A legal exposure rather than a technical one — but a real one, and the kind an investor\u2019s lawyer asks about.'),
  )

  const geo = await geoipStatus()
  out.push(
    geo.available
      ? ok(s, 'privacy.geoip', 'Geolocation resolved locally', `Database in ${geo.directory}`)
      : warn(s, 'privacy.geoip', 'No local geolocation database', 'No local database installed',
          'Country flags will be missing unless traffic passes through Cloudflare. Install GeoLite2 — never call a third-party API, which would export visitor IPs.', 'LOW',
          'Cosmetic. You still see every address; you just cannot see which country it came from at a glance.'),
  )

  try {
    const rows: Array<{ count: bigint }> = await prismaPrivileged.$queryRawUnsafe(
      `SELECT COUNT(*)::bigint AS count FROM "AccessAttempt" WHERE "createdAt" < NOW() - INTERVAL '${ACCESS_RETENTION_DAYS} days'`,
    )
    const overdue = Number(rows?.[0]?.count ?? 0)
    out.push(
      overdue === 0
        ? ok(s, 'privacy.purged', 'No records past their retention window', 'Purge is keeping up')
        : fail(s, 'privacy.purged', 'Records kept past their retention window',
            `${overdue} record(s) older than ${ACCESS_RETENTION_DAYS} days`,
            'The purge job is not running. Personal data is being kept longer than the stated policy.', 'HIGH',
            'You are keeping personal data longer than your own privacy policy promises. That gap is the problem, not the data.'),
    )
  } catch {
    out.push(skip(s, 'privacy.purged', 'No records past their retention window', 'Access table not readable'))
  }

  return out
}

/**
 * Which installation this run describes.
 *
 * A scan of a developer laptop is not evidence about the production system,
 * and a report that does not say which one it looked at invites exactly that
 * confusion — including from the person who ran it. The database host is the
 * honest identifier: the app can be started with any NODE_ENV, but it can only
 * be talking to one database.
 */
export function describeEnvironment(): string {
  const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development'
  let host = 'unknown host'
  try {
    const url = process.env.DATABASE_URL || ''
    if (url) host = new URL(url).hostname || host
  } catch {
    // A malformed URL is its own problem; the scan should not die over it.
  }
  return `${mode} · ${host}`
}

export const SCAN_STAGES: ScanStage[] = [
  // daily: true — state that changes underneath you, with nobody deploying.
  { id: 'server', label: 'Server state', blurb: 'Database, Redis, worker, migrations', daily: true, run: stageServer },
  { id: 'transport', label: 'Transport', blurb: 'HTTPS and cookie hardening', daily: true, run: stageTransport },
  { id: 'secrets', label: 'Secrets', blurb: 'Signing key strength and separation', daily: true, run: stageSecrets },
  { id: 'isolation', label: 'Tenant isolation', blurb: 'Row-level security across companies', daily: true, run: stageIsolation },
  { id: 'sessions', label: 'Sessions', blurb: 'Token lifetime, rotation, replay detection', daily: true, run: stageSessions },
  { id: 'accounts', label: 'Accounts', blurb: 'Hashing, roles, dormant users, invites', daily: true, run: stageAccounts },
  { id: 'exposure', label: 'Data exposure', blurb: 'Public shares, expiry, source maps', daily: true, run: stageExposure },
  { id: 'privacy', label: 'Privacy', blurb: 'Retention, local geolocation, purge', daily: true, run: stagePrivacy },
  // daily: false — these can only change when a new image is deployed, so a
  // daily run would re-derive the same answer at the cost of a directory hash
  // and a handful of DNS lookups.
  { id: 'files', label: 'File integrity', blurb: 'App files unchanged since the build', daily: false, run: stageFiles },
  { id: 'content', label: 'Content safety', blurb: 'Comment sanitisation, attachment types', daily: false, run: stageContent },
  { id: 'dependencies', label: 'Dependencies', blurb: 'Known vulnerabilities in packages', daily: false, run: stageDependencies },
  { id: 'reputation', label: 'Mail reputation', blurb: 'SPF and DMARC for outbound mail', daily: false, run: stageReputation },
]

/** The stages a given run covers. */
export function stagesFor(kind: 'FULL' | 'DAILY'): ScanStage[] {
  return kind === 'DAILY' ? SCAN_STAGES.filter((s) => s.daily) : SCAN_STAGES
}

/**
 * One number for a slide.
 *
 * Weighted so that a single critical failure cannot be buried under twenty
 * passing checks — which is the failure mode of every "97% secure" badge.
 * Skipped checks are excluded entirely rather than counted as passes: a check
 * that did not run is not evidence of anything.
 */
export function computeScore(findings: Finding[]): number {
  const weight: Record<FindingSeverity, number> = {
    INFO: 1, LOW: 2, MEDIUM: 4, HIGH: 8, CRITICAL: 16,
  }
  let earned = 0
  let possible = 0
  for (const f of findings) {
    if (f.status === 'SKIPPED') continue
    const w = weight[f.severity] || 1
    possible += w
    if (f.status === 'PASS') earned += w
    else if (f.status === 'WARN') earned += w * 0.5
  }
  if (possible === 0) return 0
  return Math.round((earned / possible) * 100)
}

/** Run the stages for this kind of scan, reporting progress. Never throws. */
export async function runSecurityScan(
  onProgress: (update: {
    stageId: string
    stageLabel: string
    index: number
    total: number
    findings: Finding[]
  }) => Promise<void> | void,
  kind: 'FULL' | 'DAILY' = 'FULL',
): Promise<Finding[]> {
  const stages = stagesFor(kind)
  const all: Finding[] = []
  for (let i = 0; i < stages.length; i += 1) {
    const stage = stages[i]
    let findings: Finding[] = []
    try {
      findings = await stage.run()
    } catch (error) {
      logError(`[SECURITY-SCAN] Stage ${stage.id} threw:`, error)
      // A stage that crashes must not silently look clean.
      findings = [
        skip(stage.id, `${stage.id}.error`, `${stage.label} completed`,
          `Stage failed to run: ${String(error).slice(0, 200)}`),
      ]
    }
    all.push(...findings)
    await onProgress({
      stageId: stage.id,
      stageLabel: stage.label,
      index: i + 1,
      total: stages.length,
      findings,
    })
  }
  return all
}
