import { prisma, setOrgContextOn } from '@/lib/db'
import { logError, logMessage } from '@/lib/logging'
import { editKeyFromName, fcVideoCode } from '@/lib/fc-id'

/**
 * 7.20.0: the Meta ID, "FC<n>", on the server.
 *
 * A Meta ID belongs to a FOLDER (`Folder.metaNumber`) — CPC's unit for one
 * Meta ad, with a subfolder per aspect ratio — and every video anywhere
 * under that folder carries it. Nothing is stored on the video: the number
 * is resolved through the folder tree whenever a card, a search result or
 * a download needs it, so a V2 uploaded next week, a 1:1 added later or a
 * file moved in carries the ad's ID with nobody re-running anything, and a
 * file moved out stops carrying it.
 *
 * `createMetaResolver` memoises the folder rows it reads, so a listing, a
 * search page or a folder ZIP pays one query per tree LEVEL, not one per
 * video. The client is the caller's: the armed `prisma` on tenant and share
 * routes (each arms its org first), so RLS applies as everywhere else.
 */

type FolderRow = { parentFolderId: string | null; metaNumber: number | null; organizationId: string | null }

/** The ad a folder belongs to: the folder carrying the Meta ID, and the number. */
export interface MetaAd {
  adFolderId: string
  metaNumber: number
  organizationId: string | null
}

export function createMetaResolver(client: any = prisma) {
  const rows = new Map<string, FolderRow | null>()
  const answers = new Map<string, MetaAd | null>()

  async function loadChains(ids: string[]): Promise<void> {
    let frontier = Array.from(new Set(ids.filter((id) => id && !rows.has(id))))
    // Folder trees are a handful of levels deep; the guard only stops a
    // cycle that a corrupted row could make.
    for (let depth = 0; frontier.length > 0 && depth < 64; depth++) {
      const found = (await client.folder.findMany({
        where: { id: { in: frontier } },
        select: { id: true, parentFolderId: true, metaNumber: true, organizationId: true },
      })) as Array<{ id: string } & FolderRow>
      const seen = new Set<string>()
      for (const f of found) {
        rows.set(f.id, { parentFolderId: f.parentFolderId, metaNumber: f.metaNumber, organizationId: f.organizationId })
        seen.add(f.id)
      }
      for (const id of frontier) if (!seen.has(id)) rows.set(id, null)
      frontier = Array.from(
        new Set(
          found
            .filter((f) => f.metaNumber == null && f.parentFolderId && !rows.has(f.parentFolderId))
            .map((f) => f.parentFolderId as string),
        ),
      )
    }
  }

  function answer(id: string): MetaAd | null {
    if (answers.has(id)) return answers.get(id) as MetaAd | null
    const chain: string[] = []
    let cursor: string | null = id
    let result: MetaAd | null = null
    while (cursor && chain.length < 64) {
      chain.push(cursor)
      const row = rows.get(cursor)
      if (!row) break
      if (row.metaNumber != null) {
        result = { adFolderId: cursor, metaNumber: row.metaNumber, organizationId: row.organizationId }
        break
      }
      cursor = row.parentFolderId
    }
    for (const c of chain) answers.set(c, result)
    return result
  }

  return {
    /** The ad of every folder id given (null for none / the project root). */
    async resolveAds(folderIds: Array<string | null | undefined>): Promise<Map<string, MetaAd | null>> {
      const ids = folderIds.filter((id): id is string => !!id)
      await loadChains(ids)
      const out = new Map<string, MetaAd | null>()
      for (const id of ids) out.set(id, answer(id))
      return out
    },
    /** Meta number for every folder id given (null for none / the project root). */
    async resolveMany(folderIds: Array<string | null | undefined>): Promise<Map<string, number | null>> {
      const ads = await this.resolveAds(folderIds)
      const out = new Map<string, number | null>()
      for (const [id, ad] of ads) out.set(id, ad?.metaNumber ?? null)
      return out
    },
    async resolve(folderId: string | null | undefined): Promise<number | null> {
      if (!folderId) return null
      await loadChains([folderId])
      return answer(folderId)?.metaNumber ?? null
    },
  }
}

/** One-off lookup: the Meta number a video in `folderId` carries. */
export async function metaNumberForFolder(folderId: string | null | undefined, client: any = prisma) {
  return createMetaResolver(client).resolve(folderId)
}

export interface CodedVideo {
  id: string
  folderId?: string | null
  name?: string | null
  version?: number | null
  mediaType?: string | null
  createdAt?: Date | string | null
}

/**
 * 7.20.0: every video's full code, "FC2E1V1" — ad, edit, version. Only
 * VIDEO rows under an ad folder get one. The edit (E) is found by
 * `editKeyFromName(name)` in the ad's `MetaEdit` rows; a key not seen
 * before is given the ad's next number HERE, under a lock on the ad
 * folder's row, in natural name order — so a 4:5 uploaded tomorrow lands on
 * the E its 9:16 already has, and a new edit takes the next free one, on
 * whichever page first shows it. The key comes from the card's NAME (the
 * stack's, shared by every version), so renaming a mis-named card fixes
 * its pairing. V is the version's position in its stack, the card's chip.
 *
 * Never throws: a lookup that fails leaves those videos without a code
 * (logged) rather than breaking a listing or a download.
 */
export async function resolveVideoCodes(
  videos: CodedVideo[],
  client: any = prisma,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  try {
    const eligible = videos.filter((v) => (v.mediaType ?? 'VIDEO') === 'VIDEO' && v.folderId)
    if (eligible.length === 0) return out
    const ads = await createMetaResolver(client).resolveAds(eligible.map((v) => v.folderId))

    // Group by ad folder.
    const byAd = new Map<string, { ad: MetaAd; items: Array<{ v: CodedVideo; key: string }> }>()
    for (const v of eligible) {
      const ad = ads.get(v.folderId as string)
      if (!ad) continue
      const key = editKeyFromName(v.name ?? '')
      if (!key) continue
      const slot = byAd.get(ad.adFolderId) ?? { ad, items: [] }
      slot.items.push({ v, key })
      byAd.set(ad.adFolderId, slot)
    }

    for (const { ad, items } of byAd.values()) {
      const keys = Array.from(new Set(items.map((i) => i.key)))
      const known = new Map<string, number>()
      const rows = (await client.metaEdit.findMany({
        where: { folderId: ad.adFolderId, editKey: { in: keys } },
        select: { editKey: true, editNumber: true },
      })) as Array<{ editKey: string; editNumber: number }>
      for (const r of rows) known.set(r.editKey, r.editNumber)

      const missing = keys.filter((k) => !known.has(k))
      if (missing.length > 0 && ad.organizationId) {
        // Natural name order — C1, C2, … C10 → E1, E2, … E10 — which is how
        // the editors number their edits; upload order gave C3 the E1 on the
        // first try. Only the FIRST numbering follows it: a later edit takes
        // the next free number wherever its name would sort.
        missing.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
        const assigned = await allocateEdits(ad.adFolderId, ad.organizationId, missing)
        for (const [k, n] of assigned) known.set(k, n)
      }

      for (const { v, key } of items) {
        const edit = known.get(key)
        if (edit != null) out.set(v.id, fcVideoCode(ad.metaNumber, edit, v.version ?? 1))
      }
    }
  } catch (err) {
    logError('[meta-id] could not resolve video codes:', err)
  }
  return out
}

/** Gives each new key under one ad the next edit number, in the order given. */
async function allocateEdits(
  adFolderId: string,
  organizationId: string,
  keys: string[],
): Promise<Map<string, number>> {
  return prisma.$transaction(async (tx) => {
    await setOrgContextOn(tx, organizationId)
    // Serialises every allocation for this ad: two pages showing the same
    // new 4:5 at once get the same E, not two.
    await tx.$queryRaw`SELECT id FROM "Folder" WHERE id = ${adFolderId} FOR UPDATE`
    const existing = await tx.metaEdit.findMany({
      where: { folderId: adFolderId },
      select: { editKey: true, editNumber: true },
    })
    const result = new Map<string, number>()
    let next = 0
    for (const e of existing) {
      next = Math.max(next, e.editNumber)
      if (keys.includes(e.editKey)) result.set(e.editKey, e.editNumber)
    }
    const fresh = keys.filter((k) => !result.has(k))
    if (fresh.length > 0) {
      const data = fresh.map((k) => ({ organizationId, folderId: adFolderId, editKey: k, editNumber: ++next }))
      await tx.metaEdit.createMany({ data })
      for (const d of data) result.set(d.editKey, d.editNumber)
    }
    return result
  })
}

/** One video's code, or null (no ad, not a video, lookup failed). */
export async function fcCodeForVideo(video: CodedVideo, client: any = prisma): Promise<string | null> {
  return (await resolveVideoCodes([video], client)).get(video.id) ?? null
}

/** Every live folder id in the subtree under (and including) `rootId`. */
export async function folderSubtreeIds(rootIds: string[], client: any = prisma): Promise<string[]> {
  const all = new Set(rootIds)
  let frontier = [...rootIds]
  for (let depth = 0; frontier.length > 0 && depth < 64; depth++) {
    const children = (await client.folder.findMany({
      where: { parentFolderId: { in: frontier }, deletedAt: null },
      select: { id: true },
    })) as Array<{ id: string }>
    frontier = children.map((c) => c.id).filter((id) => !all.has(id))
    for (const id of frontier) all.add(id)
  }
  return Array.from(all)
}

export type GenerateMetaIdResult =
  | { ok: true; metaNumber: number; created: boolean }
  | { ok: false; status: number; error: string }

/**
 * Right-click → Generate Meta ID. One interactive transaction armed with
 * the org: the folder must be live, no folder ABOVE it may carry a Meta ID
 * (it would already be inside an ad) and none BELOW it (two IDs for one
 * video). The company's counter row is locked for the increment, so two
 * admins generating at the same moment get two numbers; the unique index
 * on (organizationId, metaNumber) backs it. A folder that already has one
 * answers with it — the click is safe to repeat.
 */
export async function generateMetaId(folderId: string, organizationId: string): Promise<GenerateMetaIdResult> {
  return prisma.$transaction(async (tx) => {
    await setOrgContextOn(tx, organizationId)
    const folder = await tx.folder.findUnique({
      where: { id: folderId },
      select: { id: true, name: true, parentFolderId: true, metaNumber: true, deletedAt: true },
    })
    if (!folder || folder.deletedAt) return { ok: false, status: 404, error: 'Folder not found' }
    if (folder.metaNumber != null) return { ok: true, metaNumber: folder.metaNumber, created: false }

    const above = folder.parentFolderId ? await createMetaResolver(tx).resolve(folder.parentFolderId) : null
    if (above != null) {
      return {
        ok: false,
        status: 409,
        error: `This folder is inside an ad that already has Meta ID FC${above}. Its videos carry that ID.`,
      }
    }
    const subtree = await folderSubtreeIds([folder.id], tx)
    const below = await tx.folder.findFirst({
      where: { id: { in: subtree.filter((id) => id !== folder.id) }, metaNumber: { not: null } },
      select: { name: true, metaNumber: true },
    })
    if (below) {
      return {
        ok: false,
        status: 409,
        error: `The folder “${below.name}” inside it already has Meta ID FC${below.metaNumber}. Remove that one first.`,
      }
    }

    await tx.$executeRaw`
      INSERT INTO "VideoFcCounter" ("organizationId", "lastNumber")
      VALUES (${organizationId}, 0)
      ON CONFLICT ("organizationId") DO NOTHING`
    const locked = await tx.$queryRaw<Array<{ lastNumber: number }>>`
      SELECT "lastNumber" FROM "VideoFcCounter"
      WHERE "organizationId" = ${organizationId} FOR UPDATE`
    const next = (locked[0]?.lastNumber ?? 0) + 1
    await tx.$executeRaw`
      UPDATE "VideoFcCounter" SET "lastNumber" = ${next}
      WHERE "organizationId" = ${organizationId}`
    await tx.folder.update({ where: { id: folder.id }, data: { metaNumber: next } })
    logMessage(`[meta-id] FC${next} given to folder ${folder.id} (“${folder.name}”) in ${organizationId}`)
    return { ok: true as const, metaNumber: next, created: true, subtree }
  }).then(async (res: any) => {
    // Number every edit already in the ad at once, in name order (C1 → E1),
    // rather than in the order pages happen to show them.
    if (res.ok && res.created) {
      const videos = await prisma.video.findMany({
        where: { folderId: { in: res.subtree }, deletedAt: null, mediaType: 'VIDEO' } as any,
        select: { id: true, folderId: true, name: true, version: true, mediaType: true, createdAt: true },
      })
      await resolveVideoCodes(videos as CodedVideo[])
    }
    return res.ok ? { ok: true, metaNumber: res.metaNumber, created: res.created } : res
  })
}

/** Right-click → Remove Meta ID. The number is not handed out again. */
export async function removeMetaId(folderId: string, organizationId: string): Promise<number | null> {
  return prisma.$transaction(async (tx) => {
    await setOrgContextOn(tx, organizationId)
    const folder = await tx.folder.findUnique({ where: { id: folderId }, select: { metaNumber: true } })
    if (!folder?.metaNumber) return null
    await tx.folder.update({ where: { id: folderId }, data: { metaNumber: null } })
    // The ad's edits go with it; a new Meta ID later starts again at E1.
    await tx.metaEdit.deleteMany({ where: { folderId } })
    logMessage(`[meta-id] FC${folder.metaNumber} removed from folder ${folderId} in ${organizationId}`)
    return folder.metaNumber
  })
}
