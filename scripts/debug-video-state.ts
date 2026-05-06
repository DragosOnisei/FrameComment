/**
 * One-shot diagnostic: list the most recent videos with their status, approval
 * flag and which storage paths exist. Run with:
 *
 *   npx tsx scripts/debug-video-state.ts
 *
 * This script is not part of the application; it's a temporary tool for
 * debugging the "Loading video..." stall.
 */
import 'dotenv/config'
import { config as dotenvConfig } from 'dotenv'
import path from 'node:path'

dotenvConfig({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const videos = await prisma.video.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: {
      id: true,
      name: true,
      status: true,
      approved: true,
      originalStoragePath: true,
      preview720Path: true,
      preview1080Path: true,
      thumbnailPath: true,
      project: {
        select: {
          id: true,
          slug: true,
          title: true,
          authMode: true,
          skipTranscoding: true,
          usePreviewForApprovedPlayback: true,
        },
      },
    },
  })

  console.log(JSON.stringify(
    videos.map((v) => ({
      id: v.id,
      name: v.name,
      status: v.status,
      approved: v.approved,
      has_original: !!v.originalStoragePath,
      has_720: !!v.preview720Path,
      has_1080: !!v.preview1080Path,
      has_thumb: !!v.thumbnailPath,
      project: v.project,
    })),
    null,
    2,
  ))
}

main()
  .catch((err) => {
    console.error('FAILED:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
