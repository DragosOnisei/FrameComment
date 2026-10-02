import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getRedis } from '@/lib/redis'
export const runtime = 'nodejs'




// Prevent static generation for this route
export const dynamic = 'force-dynamic'

/**
 * Health Check Endpoint
 *
 * Public endpoint for Docker health checks and monitoring systems
 * Returns minimal information - only service availability status
 *
 * SECURITY: No authentication required (needed for health checks)
 * SECURITY: No configuration or internal state exposed
 * SECURITY: Rate limiting not applied (health checks need to be reliable)
 *
 * 7.17.6: the response carries the running VERSION. Deploys are automatic
 * now — a tag builds the image, Watchtower on the TrueNAS box replaces the
 * containers within five minutes — and this is how a release is confirmed
 * live, by polling until the version here matches the tag (DEPLOY_TRUENAS.md).
 * The version was deliberately withheld before; it is public anyway: every
 * build is a tag on Docker Hub, and the app shows it after sign-in.
 * `NEXT_PUBLIC_APP_VERSION` is baked at image build (Dockerfile ARG
 * APP_VERSION from the git tag); `npm_package_version` is the dev-server
 * fallback. The `status: 'ok'` field stays — the Docker HEALTHCHECK and the
 * compose health checks read the status code, older monitors read the field.
 */
const APP_VERSION =
  process.env.NEXT_PUBLIC_APP_VERSION || process.env.npm_package_version || null

export async function GET() {
  try {
    // Quick database connectivity check
    await prisma.$queryRaw`SELECT 1`

    // Quick Redis connectivity check
    const redis = getRedis()
    await redis.ping()

    // All checks passed
    return NextResponse.json(
      { status: 'ok', ok: true, name: 'framecomment', version: APP_VERSION },
      {
        status: 200,
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        }
      }
    )
  } catch (error) {
    // Service unhealthy - return 503 Service Unavailable
    return NextResponse.json(
      { status: 'error', ok: false, name: 'framecomment', version: APP_VERSION },
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        }
      }
    )
  }
}
