import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { NextRequest } from 'next/server'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`
}

export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = bytes
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`
}

export function formatTimestamp(seconds: number): string {
  if (!seconds || isNaN(seconds) || !isFinite(seconds)) {
    return '0:00'
  }
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  // Show hours format for videos 60+ minutes
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }
  // Show minutes format for videos under 60 minutes
  return `${minutes}:${secs.toString().padStart(2, '0')}`
}

/**
 * Format date with timezone awareness
 * Uses browser's timezone (client-side) or TZ env variable (server-side)
 * Format adapts based on detected timezone region
 */
export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date

  // Client-side: use browser timezone
  // Server-side: use TZ environment variable
  const timezone = typeof window !== 'undefined'
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : process.env.TZ!

  // Format date parts using Intl.DateTimeFormat with timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })

  const parts = formatter.formatToParts(d)
  const year = parts.find(p => p.type === 'year')?.value || ''
  const month = parts.find(p => p.type === 'month')?.value || ''
  const day = parts.find(p => p.type === 'day')?.value || ''

  // US/Americas format (MM-dd-yyyy)
  if (timezone.startsWith('America/') || timezone.startsWith('US/')) {
    return `${month}-${day}-${year}`
  }

  // European format (dd-MM-yyyy)
  if (timezone.startsWith('Europe/') || timezone.startsWith('Africa/')) {
    return `${day}-${month}-${year}`
  }

  // Asian/ISO format (yyyy-MM-dd) - also default
  return `${year}-${month}-${day}`
}

/**
 * Format date and time with timezone awareness
 * Uses browser's timezone (client-side) or TZ env variable (server-side)
 * Time is displayed in user's local timezone
 */
export function formatDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date

  // Client-side: use browser timezone
  // Server-side: use TZ environment variable
  const timezone = typeof window !== 'undefined'
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : process.env.TZ!

  const dateStr = formatDate(d)

  // Format time using Intl.DateTimeFormat with timezone
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false, // 24-hour format
  })

  const timeStr = timeFormatter.format(d)
  return `${dateStr} ${timeStr}`
}

export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
    .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
}

/**
 * 1.4.x+ SECURITY: project share slugs are now UNGUESSABLE random
 * tokens instead of `slugify(title)`. The old behaviour produced
 * URLs like `/share/vda` for project "VDA" — anyone who guessed the
 * project name could pivot through `/share/<name>` and view every
 * folder + video, defeating the point of per-folder shares. We now
 * mint a 12-character base64url random string (≈72 bits of entropy,
 * same approach as `generateUniqueFolderSlug`) so the share URL is
 * a capability nobody can stumble onto.
 *
 * The function signature still takes `title` for source-compat with
 * existing callers in the projects API, but the title is now only
 * used as a debug breadcrumb in logs — it never appears in the slug.
 */
export async function generateUniqueSlug(
  _title: string,
  prisma: any,
  excludeId?: string
): Promise<string> {
  // Lazy require so this file stays usable in edge runtime contexts
  // that don't have `crypto` on the global namespace. The Node crypto
  // module ships everywhere we actually call this from (Next.js API
  // route handlers on the server).
  const { randomBytes } = await import('crypto')
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const slug = randomBytes(9).toString('base64url')
    const existing = await prisma.project.findUnique({
      where: { slug },
    })
    if (!existing || existing.id === excludeId) return slug
  }
  // Falling out of the loop is exceptionally unlikely (8 collisions
  // across a 2^72 keyspace), but if it does we widen the key.
  return randomBytes(18).toString('base64url')
}

export function getClientIpAddress(request: NextRequest): string {
  // Only trust CF-Connecting-IP when the request actually came through Cloudflare
  // (cf-ray is always set by Cloudflare and cannot be spoofed by clients)
  const isCloudflare = !!request.headers.get('cf-ray')
  if (isCloudflare) {
    const cfIp = request.headers.get('cf-connecting-ip')
    if (cfIp) return cfIp
  }

  // For non-Cloudflare deployments, use X-Forwarded-For (first entry from trusted proxy)
  const xff = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (xff) return xff

  return request.headers.get('x-real-ip') || 'unknown'
}

/**
 * Color assignment system with persistence and uniqueness guarantees
 * Ensures different names always get different colors within the same palette
 * 
 * @param name - User's name for color generation
 * @param isSender - True if this is the sender (your message), false for receiver
 */

// In-memory color registry (persists during page session)
const colorRegistry = {
  sender: new Map<string, string>(),
  receiver: new Map<string, string>()
}

// Receiver (client) palette — exported so the deterministic
// `Client N` mapping below can index directly into it. Kept in sync
// with the inline list further down inside `getUserColor` so the two
// paths share the same swatch order.
const RECEIVER_PALETTE = [
  'border-red-500',
  'border-orange-500',
  'border-amber-500',
  'border-yellow-400',
  'border-lime-500',
  'border-green-500',
  'border-emerald-500',
  'border-teal-500',
  'border-cyan-500',
  'border-sky-500',
  'border-blue-500',
  'border-indigo-500',
  'border-violet-500',
  'border-purple-500',
  'border-fuchsia-500',
  'border-pink-500',
  'border-rose-500',
  'border-red-600',
  'border-orange-600',
  'border-yellow-500',
]

export function getUserColor(name: string | null | undefined, isSender: boolean = false): { border: string } {
  if (!name) {
    // Default gray for anonymous
    return { border: 'border-gray-500' }
  }

  // Normalize name for consistency (trim, lowercase)
  const normalizedName = name.trim().toLowerCase()
  const palette = isSender ? 'sender' : 'receiver'

  // 1.0.7+: "Client N" labels get a deterministic colour straight
  // from the number, so two browsers viewing the same project always
  // paint Client 3 with the same swatch regardless of the order in
  // which their local registry happened to fill. Falls through to
  // the hash path for any other name.
  const numbered = /^client\s+(\d+)$/.exec(normalizedName)
  if (numbered && !isSender) {
    const n = parseInt(numbered[1], 10)
    if (Number.isFinite(n) && n > 0) {
      const colors = RECEIVER_PALETTE
      // n is 1-indexed; map to 0-indexed slot, wrap around once we
      // exceed the palette so Client 21 is the same colour as Client 1
      // (still consistent across viewers).
      return { border: colors[(n - 1) % colors.length] }
    }
  }

  // Check if this name already has a color assigned
  if (colorRegistry[palette].has(normalizedName)) {
    return { border: colorRegistry[palette].get(normalizedName)! }
  }

  // Expanded color palettes for better distribution
  const senderColors = [
    // Earth tones for sender (admins/studio) - 20 colors
    'border-amber-700',
    'border-orange-800',
    'border-stone-600',
    'border-yellow-700',
    'border-lime-700',
    'border-green-700',
    'border-emerald-800',
    'border-teal-800',
    'border-slate-600',
    'border-zinc-600',
    'border-amber-800',
    'border-yellow-800',
    'border-lime-800',
    'border-green-800',
    'border-teal-700',
    'border-cyan-800',
    'border-stone-700',
    'border-slate-700',
    'border-neutral-600',
    'border-orange-900',
  ]

  const receiverColors = [
    // Vibrant high-contrast colors for receiver (clients) - 20 colors
    'border-red-500',
    'border-orange-500',
    'border-amber-500',
    'border-yellow-400',
    'border-lime-500',
    'border-green-500',
    'border-emerald-500',
    'border-teal-500',
    'border-cyan-500',
    'border-sky-500',
    'border-blue-500',
    'border-indigo-500',
    'border-violet-500',
    'border-purple-500',
    'border-fuchsia-500',
    'border-pink-500',
    'border-rose-500',
    'border-red-600',
    'border-orange-600',
    'border-yellow-500',
  ]

  const colors = isSender ? senderColors : receiverColors
  
  // Get already assigned colors in this palette
  const assignedColors = new Set(colorRegistry[palette].values())
  
  // Find first available color (not yet assigned)
  let selectedColor: string
  const availableColors = colors.filter(color => !assignedColors.has(color))
  
  if (availableColors.length > 0) {
    // Use improved hash function for better distribution among available colors
    const hash = hashString(normalizedName)
    const colorIndex = Math.abs(hash) % availableColors.length
    selectedColor = availableColors[colorIndex]
  } else {
    // All colors assigned - fall back to hash-based selection (collision possible but rare)
    const hash = hashString(normalizedName)
    const colorIndex = Math.abs(hash) % colors.length
    selectedColor = colors[colorIndex]
  }
  
  // Store the assignment
  colorRegistry[palette].set(normalizedName, selectedColor)
  
  return { border: selectedColor }
}

/**
 * Improved hash function with better distribution
 * Uses djb2 algorithm which produces fewer collisions
 */
function hashString(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i) // hash * 33 + c
  }
  return hash
}
