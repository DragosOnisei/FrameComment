'use client'

/**
 * 6.2.0 Founder → AI Agents (skeleton).
 *
 * Phase 4 adds the registry (Agent / AgentRun / AgentReport), manual runs and
 * saved reports, then scheduling on the existing BullMQ worker with cost caps.
 *
 * Scope note, stated in the UI so it stays honest: these agents report and
 * document. They do not run attacks. A real penetration test is done by
 * specialists; what an agent can usefully prepare is the scope, the checklist,
 * the remediation plan and the evidence pack.
 */

import { EmptySection, FounderCard, FounderPage, MetricTile } from '@/components/founder/FounderPage'

export default function FounderAgentsPage() {
  return (
    <FounderPage
      title="AI Agents"
      subtitle="Recurring work that runs without you: reports, reviews and documentation."
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile label="Agents" value={null} hint="Configured" />
        <MetricTile label="Runs today" value={null} hint="Manual and scheduled" />
        <MetricTile label="Reports" value={null} hint="Saved, exportable as PDF" />
        <MetricTile label="Spend this month" value={null} hint="Model usage" />
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <FounderCard title="Registry">
          <EmptySection
            title="No agents yet"
            description="Each agent gets a purpose, a prompt, a cadence and a cost cap. Phase 4 starts with manual runs so you can read the output before anything runs on its own."
          />
        </FounderCard>

        <FounderCard title="Run history">
          <EmptySection
            title="No runs yet"
            description="Every run keeps its input, output, duration and cost, so a report can always be traced back to what produced it."
          />
        </FounderCard>
      </div>

      <div className="mt-4">
        <FounderCard title="What these agents will and won't do">
          <div className="grid gap-3 sm:grid-cols-2 text-sm">
            <div className="rounded-lg bg-white/[0.03] ring-1 ring-white/10 p-3.5">
              <p className="font-medium text-foreground/90">They will</p>
              <ul className="mt-2 space-y-1.5 text-muted-foreground">
                <li>Summarize business and usage data into readable reports</li>
                <li>Review logs for anomalies and failed payments</li>
                <li>Inventory dependencies against known CVEs</li>
                <li>Check configuration: headers, permissions, retention</li>
                <li>Draft the incident-response plan and policies</li>
                <li>Assemble due-diligence answers with evidence</li>
              </ul>
            </div>
            <div className="rounded-lg bg-white/[0.03] ring-1 ring-white/10 p-3.5">
              <p className="font-medium text-foreground/90">They won&apos;t</p>
              <ul className="mt-2 space-y-1.5 text-muted-foreground">
                <li>Run attacks or exploit tooling against the platform</li>
                <li>Stand in for a penetration test by specialists</li>
                <li>Act on customer media, comments or share links</li>
              </ul>
              <p className="mt-3 text-xs text-muted-foreground">
                Exploit tooling running inside your own product is a risk, not a
                control. The agents prepare the scope and the remediation; the
                test itself belongs to a security firm.
              </p>
            </div>
          </div>
        </FounderCard>
      </div>
    </FounderPage>
  )
}
