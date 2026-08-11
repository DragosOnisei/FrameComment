'use client'

/**
 * 6.2.0 Founder → Dashboard (skeleton).
 *
 * The tiles are the ones Phase 2 fills with real numbers from data we already
 * store (organizations, users, BillingSnapshot, storage, activity). They render
 * an em dash until then, on purpose: an investor-facing dashboard that ever
 * showed invented figures would be worthless.
 */

import { EmptySection, FounderCard, FounderPage, MetricTile } from '@/components/founder/FounderPage'

export default function FounderDashboardPage() {
  return (
    <FounderPage
      title="Dashboard"
      subtitle="Revenue, customers and platform health in one place."
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile label="MRR" value={null} hint="Recurring revenue across paying companies" />
        <MetricTile label="Paying companies" value={null} hint="Active, with a card on file" />
        <MetricTile label="Users" value={null} hint="Across every company" />
        <MetricTile label="Storage" value={null} hint="Total stored, all backends" />
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <FounderCard title="Revenue over time">
          <EmptySection
            title="No chart yet"
            description="Phase 2 plots invoiced revenue and MRR per month from the billing snapshots already being written every day, with a period selector and a PDF export."
          />
        </FounderCard>

        <FounderCard title="Companies">
          <EmptySection
            title="No table yet"
            description="One row per company: plan, users, storage, revenue to date, last activity. Your own marketing company appears here as an ordinary customer."
          />
        </FounderCard>
      </div>

      <div className="mt-4">
        <FounderCard title="Platform activity">
          <EmptySection
            title="No activity feed yet"
            description="Signups, uploads, approvals, failed payments and security events, on one timeline, exportable for a given period."
          />
        </FounderCard>
      </div>
    </FounderPage>
  )
}
