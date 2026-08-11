'use client'

/**
 * 6.2.0 Founder → CRM (skeleton).
 *
 * Phase 3 backs this with platform-level Lead / LeadActivity / FollowUp tables,
 * seeded from the early-access requests that already arrive through the landing
 * page, and links a lead to the organization it becomes when it registers.
 */

import { EmptySection, FounderCard, FounderPage, MetricTile } from '@/components/founder/FounderPage'

export default function FounderCrmPage() {
  return (
    <FounderPage
      title="CRM"
      subtitle="Leads, customers and follow-ups, from first contact to paying company."
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile label="Open leads" value={null} hint="Not yet won or lost" />
        <MetricTile label="Follow-ups due" value={null} hint="Today and overdue" />
        <MetricTile label="Won this month" value={null} hint="Leads that became companies" />
        <MetricTile label="Conversion" value={null} hint="Requests → paying customers" />
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <FounderCard title="Pipeline">
          <EmptySection
            title="No pipeline yet"
            description="New → Contacted → Qualified → Trial → Customer, with drag between stages. Early-access requests land in New automatically."
          />
        </FounderCard>

        <FounderCard title="Follow-ups">
          <EmptySection
            title="No follow-ups yet"
            description="Each lead can carry a next step with a due date; anything due shows up in your notification bell so nothing quietly goes cold."
          />
        </FounderCard>
      </div>
    </FounderPage>
  )
}
