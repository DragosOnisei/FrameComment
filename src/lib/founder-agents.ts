/**
 * 6.7.0 Founder AI Agents (Faza 4).
 *
 * What an agent is here, precisely: a job that READS data this instance
 * already holds, assembles a report from measured facts, and — only if an
 * OpenAI key is configured — asks a model to write a short narrative on top
 * of those same facts.
 *
 * What an agent is NOT: it does not scan, probe, or attack anything; it does
 * not touch a customer's media; it does not act on its own. Every run is
 * started by hand in this release, and every run is recorded with its cost.
 *
 * The facts are computed in code, never by the model. If the model is
 * unavailable the report still ships, marked `hasNarrative: false`. A report
 * that quietly downgrades to "the model made something up" would be worse
 * than no report.
 */

import { prismaPrivileged } from './db'
import { getOpenAiApiKey } from './settings'
import { computeFounderMetrics } from './founder-metrics'
import { computeCrmSummary } from './founder-crm'
import { logError, logMessage } from './logging'

export type AgentType = 'WEEKLY_DIGEST' | 'PIPELINE_REVIEW' | 'CHURN_WATCH'

export const AGENT_CATALOG: Record<
  AgentType,
  { label: string; reads: string; question: string }
> = {
  WEEKLY_DIGEST: {
    label: 'Weekly digest',
    reads: 'Companies, users, storage, revenue and activity for the last 7 days.',
    question: 'What changed on the platform this week?',
  },
  PIPELINE_REVIEW: {
    label: 'Pipeline review',
    reads: 'Leads, their last activity, and follow-ups that are past due.',
    question: 'Who is waiting on me, and who went quiet?',
  },
  CHURN_WATCH: {
    label: 'Churn watch',
    reads: 'Paying companies with no uploads or comments in the last 30 days.',
    question: 'Which paying customers stopped using the product?',
  },
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Pricing used to estimate a run's cost. Approximate on purpose — the exact
 *  bill is OpenAI's, this is here so an expensive agent is visible. */
const MODEL = 'gpt-4o-mini'
const COST_PER_1K_IN_CENTS = 0.015
const COST_PER_1K_OUT_CENTS = 0.06

interface NarrativeResult {
  text: string | null
  model: string | null
  tokensIn: number | null
  tokensOut: number | null
  costCents: number | null
  skippedReason: string | null
}

/** Ask the model for prose over facts we already computed. Never for facts. */
async function writeNarrative(prompt: string): Promise<NarrativeResult> {
  const empty: NarrativeResult = {
    text: null,
    model: null,
    tokensIn: null,
    tokensOut: null,
    costCents: null,
    skippedReason: null,
  }

  const apiKey = await getOpenAiApiKey()
  if (!apiKey) {
    return {
      ...empty,
      skippedReason:
        'No OpenAI key is configured, so this report is the measured facts only.',
    }
  }

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: 500,
        messages: [
          {
            role: 'system',
            content:
              'You summarise business metrics for the owner of a small SaaS. Use ONLY the numbers given to you. Never invent a figure, a name, or a cause. If the data does not support a conclusion, say what is missing instead. Be brief: at most six sentences, plain language, no bullet lists, no hype.',
          },
          { role: 'user', content: prompt },
        ],
      }),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      logError('[agents] OpenAI call failed:', new Error(`${res.status} ${detail.slice(0, 200)}`))
      return {
        ...empty,
        skippedReason: `The model could not be reached (HTTP ${res.status}), so this report is the measured facts only.`,
      }
    }

    const json = await res.json()
    const text: string | null = json?.choices?.[0]?.message?.content?.trim() || null
    const tokensIn: number = json?.usage?.prompt_tokens ?? 0
    const tokensOut: number = json?.usage?.completion_tokens ?? 0
    const costCents = Math.round(
      ((tokensIn / 1000) * COST_PER_1K_IN_CENTS + (tokensOut / 1000) * COST_PER_1K_OUT_CENTS) * 100,
    ) / 100

    return {
      text,
      model: MODEL,
      tokensIn,
      tokensOut,
      costCents: Math.max(0, Math.round(costCents)),
      skippedReason: text ? null : 'The model returned nothing usable.',
    }
  } catch (error) {
    logError('[agents] narrative failed:', error)
    return {
      ...empty,
      skippedReason: 'The model could not be reached, so this report is the measured facts only.',
    }
  }
}

function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

/** Facts + a markdown body, both from the database. */
async function buildFacts(
  type: AgentType,
): Promise<{ title: string; facts: string; body: string }> {
  const now = new Date()

  if (type === 'WEEKLY_DIGEST') {
    const from = new Date(now.getTime() - 7 * DAY_MS)
    const m = await computeFounderMetrics(from, now)
    const facts = [
      `Recurring revenue: ${money(m.revenue.mrrCents)}/month (${money(m.revenue.mrrUserCents)} from users, ${money(m.revenue.mrrStorageCents)} from storage).`,
      `Companies: ${m.companies.total} total, ${m.companies.active} active, ${m.companies.onPaidTier} on a paid tier, ${m.companies.newInRange} new this week, ${m.companies.suspended} suspended.`,
      `Users: ${m.users.total} total, ${m.users.newInRange} new this week, ${m.revenue.billableUsers} billable.`,
      `Storage: ${bytes(m.storage.totalBytes)} stored, ${bytes(m.storage.billableBytes)} billable.`,
      `Activity this week: ${m.activity.uploads} uploads, ${m.activity.comments} comments, ${m.activity.approvals} approvals, ${m.activity.projectsCreated} projects created.`,
    ].join('\n')

    const body = [
      '## Numbers',
      '',
      `- **Recurring revenue** — ${money(m.revenue.mrrCents)}/mo · ${money(m.revenue.mrrUserCents)} users + ${money(m.revenue.mrrStorageCents)} storage`,
      `- **Companies** — ${m.companies.total} total · ${m.companies.active} active · ${m.companies.onPaidTier} paid · ${m.companies.newInRange} new`,
      `- **Users** — ${m.users.total} total · ${m.users.newInRange} new`,
      `- **Storage** — ${bytes(m.storage.totalBytes)} stored · ${bytes(m.storage.billableBytes)} billable`,
      `- **Activity** — ${m.activity.uploads} uploads · ${m.activity.comments} comments · ${m.activity.approvals} approvals`,
      '',
      '## Companies',
      '',
      ...m.companiesTable.map(
        (c) =>
          `- **${c.name}** — ${c.users} users · ${bytes(c.storageBytes)} · ${c.tier === 'paid' ? 'paid' : 'free'} · ${money(c.estimatedMonthlyCents)}/mo`,
      ),
    ].join('\n')

    return { title: `Weekly digest · ${now.toLocaleDateString()}`, facts, body }
  }

  if (type === 'PIPELINE_REVIEW') {
    const summary = await computeCrmSummary(now)
    const staleCutoff = new Date(now.getTime() - 14 * DAY_MS)

    const [overdue, quiet] = await Promise.all([
      (prismaPrivileged as any).followUp.findMany({
        where: { doneAt: null, dueAt: { lte: now } },
        orderBy: { dueAt: 'asc' },
        take: 50,
        include: { lead: { select: { name: true, email: true, status: true } } },
      }) as Promise<Array<{ dueAt: Date; note: string | null; lead: { name: string; email: string; status: string } }>>,
      (prismaPrivileged as any).lead.findMany({
        where: {
          status: { in: ['NEW', 'CONTACTED', 'QUALIFIED', 'TRIAL'] },
          updatedAt: { lte: staleCutoff },
        },
        orderBy: { updatedAt: 'asc' },
        take: 50,
        select: { name: true, email: true, status: true, updatedAt: true, lastContactedAt: true },
      }) as Promise<Array<{ name: string; email: string; status: string; updatedAt: Date; lastContactedAt: Date | null }>>,
    ])

    const facts = [
      `Pipeline: ${summary.total} leads, ${summary.open} open, ${summary.byStatus.CUSTOMER} customers, ${summary.byStatus.LOST} lost.`,
      `Follow-ups past due: ${overdue.length}.`,
      `Open leads untouched for 14 days or more: ${quiet.length}.`,
      summary.conversionRate != null
        ? `Conversion among decided leads: ${Math.round(summary.conversionRate * 100)}%.`
        : 'Conversion: no lead has reached a decision yet, so there is no rate to report.',
    ].join('\n')

    const body = [
      '## Where the pipeline stands',
      '',
      `- **Open** — ${summary.open} of ${summary.total}`,
      `- **Customers** — ${summary.byStatus.CUSTOMER} · **Lost** — ${summary.byStatus.LOST}`,
      `- **Follow-ups past due** — ${overdue.length}`,
      '',
      '## Past due',
      '',
      overdue.length === 0
        ? '- Nothing is past due.'
        : overdue
            .map(
              (f) =>
                `- **${f.lead.name}** (${f.lead.email}) — due ${f.dueAt.toLocaleDateString()}${f.note ? ` · ${f.note}` : ''}`,
            )
            .join('\n'),
      '',
      '## Gone quiet (14+ days)',
      '',
      quiet.length === 0
        ? '- Nobody has been left waiting.'
        : quiet
            .map(
              (l) =>
                `- **${l.name}** (${l.email}) — ${l.status.toLowerCase()} · last touched ${l.updatedAt.toLocaleDateString()}`,
            )
            .join('\n'),
    ].join('\n')

    return { title: `Pipeline review · ${now.toLocaleDateString()}`, facts, body }
  }

  // CHURN_WATCH
  const from = new Date(now.getTime() - 30 * DAY_MS)
  const m = await computeFounderMetrics(from, now)
  const paidOrgs = m.companiesTable.filter((c) => c.tier === 'paid')

  const activity = await Promise.all(
    paidOrgs.map(async (c) => {
      const [uploads, comments] = await Promise.all([
        (prismaPrivileged as any).video.count({
          where: { organizationId: c.id, createdAt: { gte: from } },
        }) as Promise<number>,
        (prismaPrivileged as any).comment.count({
          where: { organizationId: c.id, createdAt: { gte: from } },
        }) as Promise<number>,
      ])
      return { company: c, uploads, comments }
    }),
  )
  const quiet = activity.filter((a) => a.uploads === 0 && a.comments === 0)
  const atRiskCents = quiet.reduce((acc, a) => acc + a.company.estimatedMonthlyCents, 0)

  const facts = [
    `Paying companies: ${paidOrgs.length}.`,
    `Of those, ${quiet.length} had zero uploads and zero comments in the last 30 days.`,
    `Recurring revenue attached to those quiet companies: ${money(atRiskCents)}/month.`,
    quiet.length > 0
      ? `Quiet companies: ${quiet.map((a) => `${a.company.name} (${money(a.company.estimatedMonthlyCents)}/mo)`).join(', ')}.`
      : 'No paying company is inactive.',
  ].join('\n')

  const body = [
    '## Paying companies with no activity in 30 days',
    '',
    quiet.length === 0
      ? '- Every paying company used the product this month.'
      : quiet
          .map(
            (a) =>
              `- **${a.company.name}** — ${money(a.company.estimatedMonthlyCents)}/mo · ${a.company.users} users · ${bytes(a.company.storageBytes)} · no uploads, no comments`,
          )
          .join('\n'),
    '',
    `**Revenue attached to quiet companies:** ${money(atRiskCents)}/month.`,
    '',
    '_Inactivity is not cancellation. It is a reason to ask, not a conclusion._',
  ].join('\n')

  return { title: `Churn watch · ${now.toLocaleDateString()}`, facts, body }
}

/**
 * Run one agent, start to finish, recording the attempt either way.
 * Returns the run id so the caller can show the report.
 */
export async function runAgent(
  agentId: string,
  triggeredBy: string,
): Promise<{ runId: string; status: 'SUCCEEDED' | 'FAILED'; error?: string }> {
  const agent = await (prismaPrivileged as any).agent.findUnique({ where: { id: agentId } })
  if (!agent) throw new Error('Agent not found')

  const run = await (prismaPrivileged as any).agentRun.create({
    data: { agentId, status: 'RUNNING', triggeredBy },
  })
  const startedAt = Date.now()

  try {
    const { title, facts, body } = await buildFacts(agent.type as AgentType)
    const catalog = AGENT_CATALOG[agent.type as AgentType]
    const narrative = await writeNarrative(
      `${catalog.question}\n\nHere are the measured figures:\n${facts}`,
    )

    const markdown = [
      narrative.text ? `${narrative.text}\n` : '',
      narrative.skippedReason ? `_${narrative.skippedReason}_\n` : '',
      body,
    ]
      .filter(Boolean)
      .join('\n')

    await (prismaPrivileged as any).agentReport.create({
      data: { runId: run.id, title, markdown, hasNarrative: !!narrative.text },
    })

    await (prismaPrivileged as any).agentRun.update({
      where: { id: run.id },
      data: {
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt,
        model: narrative.model,
        tokensIn: narrative.tokensIn,
        tokensOut: narrative.tokensOut,
        costCents: narrative.costCents,
      },
    })
    await (prismaPrivileged as any).agent.update({
      where: { id: agentId },
      data: { lastRunAt: new Date() },
    })

    logMessage(`[agents] ${agent.type} finished in ${Date.now() - startedAt}ms`)
    return { runId: run.id, status: 'SUCCEEDED' }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    logError('[agents] run failed:', error)
    await (prismaPrivileged as any).agentRun
      .update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt,
          error: message.slice(0, 500),
        },
      })
      .catch(() => {})
    return { runId: run.id, status: 'FAILED', error: message }
  }
}

/** The registry, with each agent's last run. */
export async function listAgents() {
  const agents = await (prismaPrivileged as any).agent.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      runs: {
        orderBy: { startedAt: 'desc' },
        take: 1,
        include: { report: { select: { id: true, title: true, hasNarrative: true } } },
      },
    },
  })

  return agents.map((a: any) => ({
    id: a.id,
    name: a.name,
    type: a.type as AgentType,
    enabled: a.enabled,
    cadence: a.cadence,
    lastRunAt: a.lastRunAt ? a.lastRunAt.toISOString() : null,
    catalog: AGENT_CATALOG[a.type as AgentType] ?? null,
    lastRun: a.runs[0]
      ? {
          id: a.runs[0].id,
          status: a.runs[0].status,
          startedAt: a.runs[0].startedAt.toISOString(),
          durationMs: a.runs[0].durationMs ?? null,
          costCents: a.runs[0].costCents ?? null,
          model: a.runs[0].model ?? null,
          error: a.runs[0].error ?? null,
          reportId: a.runs[0].report?.id ?? null,
          reportTitle: a.runs[0].report?.title ?? null,
          hasNarrative: a.runs[0].report?.hasNarrative ?? false,
        }
      : null,
  }))
}

/** Recent reports across every agent. */
export async function listReports(limit = 20) {
  const reports = await (prismaPrivileged as any).agentReport.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { run: { include: { agent: { select: { name: true, type: true } } } } },
  })
  return reports.map((r: any) => ({
    id: r.id,
    title: r.title,
    hasNarrative: r.hasNarrative,
    createdAt: r.createdAt.toISOString(),
    agentName: r.run?.agent?.name ?? 'Unknown',
    costCents: r.run?.costCents ?? null,
    model: r.run?.model ?? null,
  }))
}

export async function getReport(id: string) {
  const r = await (prismaPrivileged as any).agentReport.findUnique({
    where: { id },
    include: { run: { include: { agent: { select: { name: true, type: true } } } } },
  })
  if (!r) return null
  return {
    id: r.id,
    title: r.title,
    markdown: r.markdown,
    hasNarrative: r.hasNarrative,
    createdAt: r.createdAt.toISOString(),
    agentName: r.run?.agent?.name ?? 'Unknown',
    model: r.run?.model ?? null,
    costCents: r.run?.costCents ?? null,
    tokensIn: r.run?.tokensIn ?? null,
    tokensOut: r.run?.tokensOut ?? null,
    durationMs: r.run?.durationMs ?? null,
  }
}
