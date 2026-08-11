/**
 * 6.2.0 — create (or update) the FOUNDER account.
 *
 *   npm run founder:create -- --email dragos@mindqub.eu --name "Dragos Onisei"
 *
 * The password is read from FOUNDER_PASSWORD, or asked for interactively so it
 * never ends up in your shell history. The account is created as OWNER inside
 * the PLATFORM organization (see prisma/migrations/20260806100000_platform_org),
 * which is what makes it the founder: separate from every customer company,
 * including your own.
 *
 * Safe to re-run: an existing account with that email is updated (password +
 * name + moved into the platform org) instead of duplicated.
 */

import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { PrismaClient } from '@prisma/client'
import { hashPassword, validatePassword } from '../src/lib/encryption'

const PLATFORM_ORG_ID = process.env.PLATFORM_ORG_ID?.trim() || 'org-platform'

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : null
}

async function ask(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true })
  if (hidden) {
    // Minimal masking: keep the prompt readable without echoing the secret.
    const originalWrite = (stdout as any).write.bind(stdout)
    let muted = false
    ;(stdout as any).write = (chunk: any, ...rest: any[]) =>
      muted ? true : originalWrite(chunk, ...rest)
    const promise = rl.question(question)
    muted = true
    const answer = await promise
    muted = false
    ;(stdout as any).write = originalWrite
    stdout.write('\n')
    rl.close()
    return answer
  }
  const answer = await rl.question(question)
  rl.close()
  return answer
}

async function main() {
  const prisma = new PrismaClient()
  try {
    const email = (arg('--email') || (await ask('Founder email: '))).trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error(`"${email}" is not a valid email address`)
    }
    const name = arg('--name') || 'Founder'
    const password =
      process.env.FOUNDER_PASSWORD || (await ask('Founder password (hidden): ', true))

    const check = validatePassword(password)
    if (!check.isValid) {
      throw new Error(`Password rejected: ${check.errors.join(' ')}`)
    }

    // The platform org must exist — it is created by the migration. Failing
    // loudly here beats silently creating a second "platform".
    const org = (await (prisma as any).organization.findUnique({
      where: { id: PLATFORM_ORG_ID },
      select: { id: true, name: true, isPlatform: true },
    })) as { id: string; name: string; isPlatform: boolean } | null

    if (!org) {
      throw new Error(
        `Platform organization "${PLATFORM_ORG_ID}" not found. Run \`npx prisma migrate deploy\` first.`,
      )
    }
    if (!org.isPlatform) {
      throw new Error(
        `Organization "${PLATFORM_ORG_ID}" exists but isPlatform is false — refusing to continue.`,
      )
    }

    const hashed = await hashPassword(password)
    const existing = (await (prisma as any).user.findUnique({
      where: { email },
      select: { id: true, organizationId: true },
    })) as { id: string; organizationId: string | null } | null

    if (existing) {
      await (prisma as any).user.update({
        where: { id: existing.id },
        data: {
          password: hashed,
          name,
          role: 'OWNER',
          organizationId: PLATFORM_ORG_ID,
        },
      })
      console.log(
        `✓ Updated ${email}: OWNER in ${org.name} (${PLATFORM_ORG_ID}), password reset.`,
      )
      if (existing.organizationId && existing.organizationId !== PLATFORM_ORG_ID) {
        console.log(
          `  NOTE: this account was moved out of "${existing.organizationId}". If it was that company's only Owner, give the company a new Owner.`,
        )
      }
    } else {
      await (prisma as any).user.create({
        data: {
          email,
          name,
          password: hashed,
          role: 'OWNER',
          organizationId: PLATFORM_ORG_ID,
        },
      })
      console.log(`✓ Created ${email} as OWNER in ${org.name} (${PLATFORM_ORG_ID}).`)
    }

    console.log('  Sign in at /login — you will land in /founder.')
  } finally {
    await prisma.$disconnect().catch(() => {})
  }
}

main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
