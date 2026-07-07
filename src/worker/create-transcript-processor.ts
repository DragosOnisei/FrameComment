import { Job } from 'bullmq'
import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import PDFDocument from 'pdfkit'
import { CreateTranscriptJob } from '../lib/queue'
import { prisma } from '../lib/db'
import { logMessage, logError } from '../lib/logging'
import { downloadFile, getLocalSourcePath, uploadFile } from '../lib/storage'
import { extractAudioForTranscription } from '../lib/ffmpeg'
import { getOpenAiApiKey } from '../lib/settings'
import { TEMP_DIR } from './cleanup'

// OpenAI hard-limits a transcription request to 25 MB. We downmix to
// mono 16 kHz MP3 (~0.5 MB/min) so this only trips on very long clips.
const MAX_AUDIO_BYTES = 24 * 1024 * 1024

type WhisperSegment = { start: number; end: number; text: string }

/** Seconds → `MM:SS` (or `HH:MM:SS` past the hour). */
function fmtTimecode(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

/**
 * 3.9.x: transcribe one video with OpenAI whisper-1 and drop a timecoded
 * PDF into the video's folder as a FolderDocument.
 *
 * Pipeline: resolve the source file (local STORAGE_ROOT or download) →
 * ffmpeg extract a compact mono MP3 → POST to OpenAI → render a PDF with
 * pdfkit (auto-wrapped + paginated) → upload it → create the
 * FolderDocument row so it shows as a file card in the folder.
 */
export async function processCreateTranscript(job: Job<CreateTranscriptJob>) {
  const { videoId, projectId, folderId, originalStoragePath } = job.data
  const start = Date.now()
  logMessage(`[WORKER] create-transcript for ${videoId}`)

  // Temp files we create and must clean up (audio; the source original
  // is left for the temp sweeper / other jobs, same as regenerate-thumb).
  const audioPath = path.join(TEMP_DIR, `${videoId}-transcript-audio.mp3`)

  try {
    const video = await prisma.video.findUnique({
      where: { id: videoId },
      select: {
        id: true,
        name: true,
        version: true,
        versionLabel: true,
      },
    })
    if (!video) {
      logMessage(`[WORKER] create-transcript ${videoId}: row gone, skipping`)
      return
    }

    const apiKey = await getOpenAiApiKey()
    if (!apiKey) {
      throw new Error('No OpenAI API key configured (Settings → Video Processing).')
    }

    // Resolve the source file — prefer reading directly from
    // STORAGE_ROOT (local mode); fall back to downloading (S3 mode),
    // mirroring the regenerate-thumbnail processor.
    let sourcePath: string
    const localSource = getLocalSourcePath(originalStoragePath)
    if (localSource) {
      sourcePath = localSource
    } else {
      const cachedOriginal = path.join(TEMP_DIR, `${videoId}-original`)
      if (!fs.existsSync(cachedOriginal)) {
        const stream = await downloadFile(originalStoragePath)
        await pipeline(stream, fs.createWriteStream(cachedOriginal))
      }
      sourcePath = cachedOriginal
    }

    // 1) Extract compact audio.
    await extractAudioForTranscription(sourcePath, audioPath)
    const audioBuffer = await fs.promises.readFile(audioPath)
    if (audioBuffer.length > MAX_AUDIO_BYTES) {
      throw new Error(
        `Audio is too large for a single transcription request (${(audioBuffer.length / 1024 / 1024).toFixed(1)} MB, limit 24 MB). This clip is likely very long.`,
      )
    }

    // 2) Send to OpenAI whisper-1. verbose_json returns per-segment
    //    timecodes (start/end in seconds) which we render as [MM:SS].
    const form = new FormData()
    form.append(
      'file',
      new Blob([new Uint8Array(audioBuffer)], { type: 'audio/mpeg' }),
      'audio.mp3',
    )
    form.append('model', 'whisper-1')
    form.append('response_format', 'verbose_json')

    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(`OpenAI transcription failed (${resp.status}): ${body.slice(0, 300)}`)
    }
    const data: any = await resp.json()
    const segments: WhisperSegment[] = Array.isArray(data?.segments)
      ? data.segments
          .filter((s: any) => typeof s?.text === 'string')
          .map((s: any) => ({
            start: Number(s.start) || 0,
            end: Number(s.end) || 0,
            text: String(s.text).trim(),
          }))
      : []
    const fullText: string = typeof data?.text === 'string' ? data.text.trim() : ''

    if (segments.length === 0 && !fullText) {
      throw new Error('Transcription returned no text (silent or undecodable audio).')
    }

    const versionLabel = video.versionLabel || `v${video.version}`

    // 3) Render the PDF (pdfkit auto-wraps + paginates).
    const pdfBuffer = await renderTranscriptPdf({
      title: video.name,
      versionLabel,
      generatedAt: new Date(),
      segments,
      fullText,
    })

    // 4) Upload it into the project's documents area.
    const storagePath = `projects/${projectId}/documents/transcript-${videoId}-${Date.now()}.pdf`
    await uploadFile(storagePath, pdfBuffer, pdfBuffer.length, 'application/pdf')

    // 5) Create the FolderDocument row so it appears as a file card in
    //    the same folder as the video. `prisma as any` because the
    //    sandbox's generated client may predate the model; the Docker
    //    build regenerates it so this is a real typed model at runtime.
    const docName = `${video.name} ${versionLabel} — Transcript.pdf`
    await (prisma as any).folderDocument.create({
      data: {
        projectId,
        folderId: folderId ?? null,
        name: docName,
        storagePath,
        mimeType: 'application/pdf',
        size: BigInt(pdfBuffer.length),
        kind: 'transcript',
        sourceVideoId: videoId,
      },
    })

    // Let any listening UI know a folder changed so grids refresh.
    logMessage(
      `[WORKER] create-transcript for ${videoId} done in ${((Date.now() - start) / 1000).toFixed(2)}s (${segments.length} segments)`,
    )
  } catch (err) {
    logError(`[WORKER] create-transcript for ${videoId} failed:`, err)
    throw err
  } finally {
    // Drop the temp audio; leave the cached original for the sweeper.
    try {
      if (fs.existsSync(audioPath)) await fs.promises.unlink(audioPath)
    } catch {
      /* ignore */
    }
  }
}

function renderTranscriptPdf(opts: {
  title: string
  versionLabel: string
  generatedAt: Date
  segments: WhisperSegment[]
  fullText: string
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 56, size: 'A4' })
      const chunks: Buffer[] = []
      doc.on('data', (c: Buffer) => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      // Header.
      doc.fontSize(16).fillColor('#111111').text(opts.title, { continued: false })
      doc
        .moveDown(0.2)
        .fontSize(10)
        .fillColor('#666666')
        .text(
          `Transcript · ${opts.versionLabel} · generated ${opts.generatedAt.toLocaleString()}`,
        )
      doc
        .moveDown(0.6)
        .strokeColor('#dddddd')
        .lineWidth(1)
        .moveTo(doc.x, doc.y)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .stroke()
      doc.moveDown(0.8)

      if (opts.segments.length > 0) {
        for (const seg of opts.segments) {
          if (!seg.text) continue
          doc
            .fontSize(9)
            .fillColor('#2f7bd6')
            .text(`[${fmtTimecode(seg.start)} – ${fmtTimecode(seg.end)}]`)
          doc.fontSize(11).fillColor('#111111').text(seg.text, {
            paragraphGap: 2,
            lineGap: 1,
          })
          doc.moveDown(0.5)
        }
      } else {
        // No per-segment timecodes — dump the full text.
        doc.fontSize(11).fillColor('#111111').text(opts.fullText, { lineGap: 1 })
      }

      doc.end()
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}
