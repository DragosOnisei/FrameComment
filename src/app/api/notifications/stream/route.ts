import { NextRequest, NextResponse } from 'next/server'
import { requireApiAdmin } from '@/lib/auth'
import { getRedis } from '@/lib/redis'
import { logError } from '@/lib/logging'
import { notificationChannel } from '@/lib/inapp-notifications'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 3.5.0+ GET /api/notifications/stream
 *
 * Server-Sent Events stream for the live bell. Subscribes to the
 * current admin's Redis channel and forwards each published
 * notification to the browser the instant it's created — no polling,
 * no refresh.
 *
 * Auth note: admin auth here is bearer-token only (header), so the
 * browser CANNOT use the native `EventSource` API (it can't set an
 * Authorization header). The client therefore consumes this with a
 * `fetch()` + stream reader that DOES send the header. The wire format
 * is still standard SSE (`data:` frames) so the client parser is
 * trivial. If a reverse proxy buffers `text/event-stream`, the client
 * falls back to polling `/api/notifications`.
 *
 * Lifecycle: one dedicated Redis subscriber connection per open
 * stream, torn down on disconnect. A periodic heartbeat comment keeps
 * intermediaries from idling the connection closed, and a hard cap
 * recycles the connection so a long-lived tab eventually reconnects
 * with a fresh access token.
 */

const HEARTBEAT_MS = 25_000
// Recycle after ~10 min so the client reconnects with a fresh token.
const MAX_CONNECTION_MS = 10 * 60_000

export async function GET(request: NextRequest) {
  const auth = await requireApiAdmin(request)
  if (auth instanceof Response) return auth

  const channel = notificationChannel(auth.id)
  const encoder = new TextEncoder()

  // Dedicated subscriber connection (a subscribed ioredis client can't
  // run normal commands, so we must duplicate rather than reuse).
  let sub: ReturnType<typeof getRedis> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let lifecycle: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          /* controller already closed */
        }
      }

      const cleanup = async () => {
        if (closed) return
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        if (lifecycle) clearTimeout(lifecycle)
        try {
          if (sub) {
            await sub.unsubscribe(channel).catch(() => {})
            await sub.quit().catch(() => {})
          }
        } catch {
          /* ignore */
        }
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }

      // Tell the client the stream is live so it can mark SSE healthy
      // (and not trip the polling fallback). `:` lines are SSE comments.
      send(': connected\n\n')
      send('event: ready\ndata: {}\n\n')

      try {
        sub = getRedis().duplicate()
        sub.on('message', (_chan: string, payload: string) => {
          // Forward the published notification JSON verbatim.
          send(`data: ${payload}\n\n`)
        })
        sub.on('error', (err: unknown) => {
          logError('[notifications/stream] subscriber error:', err)
        })
        await sub.subscribe(channel)
      } catch (err) {
        logError('[notifications/stream] subscribe failed:', err)
        // Surface a soft error event; client will fall back to polling.
        send('event: error\ndata: {"reason":"subscribe_failed"}\n\n')
        await cleanup()
        return
      }

      heartbeat = setInterval(() => send(': ping\n\n'), HEARTBEAT_MS)
      lifecycle = setTimeout(() => {
        void cleanup()
      }, MAX_CONNECTION_MS)

      // Browser navigated away / client aborted the fetch.
      request.signal.addEventListener('abort', () => {
        void cleanup()
      })
    },
    cancel() {
      closed = true
      if (heartbeat) clearInterval(heartbeat)
      if (lifecycle) clearTimeout(lifecycle)
      if (sub) {
        sub.unsubscribe(channel).catch(() => {})
        sub.quit().catch(() => {})
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Hint to nginx-style proxies to NOT buffer the stream.
      'X-Accel-Buffering': 'no',
    },
  })
}
