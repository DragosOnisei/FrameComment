import { notFound } from 'next/navigation'
import { prisma } from '@/lib/db'
import { armOrgForProjectSlug } from '@/lib/share-org'
import SharePageClient from './SharePageClient'

interface SharePageProps {
  params: Promise<{ token: string }>
}

export default async function SharePage({ params }: SharePageProps) {
  const { token } = await params
  // 5.5 multi-tenant: arm the owning org FIRST (privileged slug->org resolve;
  // post-flip every query below, incl. settings/rate-limit reads, is RLS-scoped).
  await armOrgForProjectSlug(token)

  // Server-side validation: check if slug exists and is not archived.
  // 2.2.6+: also filter `deletedAt: null` so soft-deleted (trashed)
  // projects look like 404 from the moment SSR runs, instead of
  // rendering the SharePageClient shell only to have its first API
  // call land on a 401 and bounce the user to the not-found state
  // (which is what users saw as "Link Not Found" after they trashed
  // a project but forgot to clear the share link).
  const project = await prisma.project.findFirst({
    where: { slug: token, deletedAt: null } as any,
    select: { id: true, status: true },
  })

  // Show not-found for non-existent or archived projects
  // Archived projects appear as if they don't exist (security)
  if (!project || project.status === 'ARCHIVED') {
    notFound()
  }

  return <SharePageClient token={token} />
}
