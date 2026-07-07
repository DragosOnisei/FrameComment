import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { getVideoQueue, VIDEO_JOB_PRIORITY, CreateTranscriptJob } from '@/lib/queue'
import { getOpenAiApiKey } from '@/lib/settings'
import { rateLimit } from '@/lib/rate-limit'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'

/**
 * 3.9.x POST /api/videos/[id]/transcript
 *
 * "Create Transcript" — right-click / kebab action on a video. Enqueues
 * a `create-transcript` job: the worker extracts the clip's audio, sends
 * it to OpenAI whisper-1, renders a timecoded PDF, and drops it into the
 * video's folder as a FolderDocument. Admin-only. Deduped per video so
 * double-clicks don't double-schedule. Fails fast with a clear message
 * when no OpenAI key is configured.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 20,
      message: 'Too many transcript requests. Please slow down.',
    },
    'video-transcript',
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const { id: videoId } = await params

    const video = await prisma.video.findUnique({
      where: { id: videoId },
      select: {
        id: true,
        projectId: true,
        folderId: true,
        originalStoragePath: true,
        mediaType: true,
        deletedAt: true,
      },
    })

    if (!video || video.deletedAt) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }
    if (video.mediaType === 'IMAGE') {
      return NextResponse.json(
        { error: 'Transcripts are only available for videos' },
        { status: 400 },
      )
    }

    // Fail fast (before enqueuing) when no key is configured, so the UI
    // can point the admin straight at Settings instead of silently
    // queuing a job that will error in the worker.
    const apiKey = await getOpenAiApiKey()
    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            'No OpenAI API key configured. Add one in Settings → Video Processing to enable transcripts.',
          code: 'NO_OPENAI_KEY',
        },
        { status: 400 },
      )
    }

    const queue = getVideoQueue()
    const job: CreateTranscriptJob = {
      videoId: video.id,
      projectId: video.projectId,
      folderId: video.folderId ?? null,
      originalStoragePath: video.originalStoragePath,
    }
    await queue.add('create-transcript', job, {
      priority: VIDEO_JOB_PRIORITY.CREATE_TRANSCRIPT,
      jobId: `transcript-${video.id}`,
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    logError('Error enqueueing create-transcript job:', error)
    return NextResponse.json(
      { error: 'Failed to enqueue transcript job' },
      { status: 500 },
    )
  }
}
