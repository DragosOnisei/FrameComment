// One-shot codemod for Multi-Tenant Phase 1 (see MULTI_TENANT_MIGRATION.md).
// Inserts `organizationId` (+ @@index) into every tenant model in
// prisma/schema.prisma, with @unique instead of an index on the two
// per-org singleton models (Settings, SecuritySettings). Idempotent:
// skips models that already have organizationId.
//
// Deliberately NOT touching:
//  - User.email uniqueness (stays global until Phase 2's login/register rework)
//  - Prisma relations (FKs are added in the hand-written SQL migration;
//    keeping the schema scalar-only avoids 32 back-relations on Organization)
import fs from 'fs'

const FILE = new URL('../prisma/schema.prisma', import.meta.url)
let src = fs.readFileSync(FILE, 'utf8')

const UNIQUE_MODELS = new Set(['Settings', 'SecuritySettings'])
const ALL_MODELS = [
  'User', 'OwnershipTransfer', 'Project', 'Folder', 'FolderDocument',
  'ProjectRecipient', 'Video', 'VideoAsset', 'ProjectUpload', 'Comment',
  'Marker', 'CommentReaction', 'NotificationQueue', 'Notification', 'Settings',
  'BillingSnapshot', 'NotificationDestination', 'NotificationSubscription',
  'NotificationDeliveryLog', 'SecuritySettings', 'SecurityEvent', 'BlockedIP',
  'BlockedDomain', 'VideoAnalytics', 'SharePageAccess', 'PasskeyCredential',
  'PushSubscription', 'EmailTemplate', 'ClientCompany', 'CalendarToken',
  'ShortLink', 'ClientContact',
]

const lines = src.split('\n')
const out = []
let currentModel = null
let alreadyHasField = false

for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  const start = line.match(/^model (\w+) \{/)

  if (start) {
    currentModel = ALL_MODELS.includes(start[1]) ? start[1] : null
    // Peek ahead: does this model already have organizationId?
    alreadyHasField = false
    for (let j = i + 1; j < lines.length && lines[j] !== '}'; j++) {
      if (/^\s*organizationId\s/.test(lines[j])) { alreadyHasField = true; break }
    }
    out.push(line)
    if (currentModel && !alreadyHasField) {
      const uniq = UNIQUE_MODELS.has(currentModel)
      out.push('  // 5.0 multi-tenant: owning organization. Nullable + DB default')
      out.push("  // 'org-1' during the staged migration (MULTI_TENANT_MIGRATION.md §11);")
      out.push('  // tightened to NOT NULL once every create passes it explicitly.')
      out.push(
        uniq
          ? '  organizationId String? @unique @default("org-1")'
          : '  organizationId String? @default("org-1")',
      )
    }
    continue
  }

  if (line === '}' && currentModel && !alreadyHasField) {
    if (!UNIQUE_MODELS.has(currentModel)) {
      out.push('')
      out.push('  @@index([organizationId])')
    }
    currentModel = null
    out.push(line)
    continue
  }

  out.push(line)
}

src = out.join('\n')

// Append the Organization model itself (once).
if (!/^model Organization \{/m.test(src)) {
  src += `
// 5.0 multi-tenant: one row per company (tenant). Every tenant-owned table
// carries an organizationId; isolation is enforced in the app AND by Postgres
// Row-Level Security policies (see MULTI_TENANT_MIGRATION.md). Named
// "Organization" because "ClientCompany" is already the client directory.
model Organization {
  id        String   @id @default(cuid())
  name      String // company/brand name shown in the UI (asked at register)
  slug      String   @unique // stable public handle, auto-generated
  // ACTIVE | SUSPENDED (billing) | DELETED (soft). Plain string to avoid an
  // enum migration dance while statuses are still evolving.
  status    String   @default("ACTIVE")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([status])
}
`
}

fs.writeFileSync(FILE, src)
console.log('schema.prisma updated')
