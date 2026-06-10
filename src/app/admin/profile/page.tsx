'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, Check, Lock, User as UserIcon, X } from 'lucide-react'
import { useAuth } from '@/components/AuthProvider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiFetch } from '@/lib/api-client'
import { logError } from '@/lib/logging'

export const dynamic = 'force-dynamic'

/**
 * 2.5.1+ Profile page — dedicated, self-only account screen.
 *
 *   ┌─────────────────────────────────────────┐
 *   │  Profile      (avatar, name, username)  │
 *   ├─────────────────────────────────────────┤
 *   │  Password     (current + new + confirm) │
 *   └─────────────────────────────────────────┘
 *
 * Designed to match the v2.5 frosted-glass vocabulary used across
 * the rest of the admin UI: low-opacity white surfaces with hairline
 * `ring-white/10` borders, `text-white` primary text, `text-white/55`
 * for muted meta, brand-blue Save buttons. Each section is its own
 * glass card so a partial save (e.g. just a name change) doesn't
 * have to revalidate the whole page.
 *
 * Avatar uploads are downsized to 256×256 JPEG client-side and sent
 * inline as a `data:` URL (see `compressAvatar` below) so we don't
 * need a separate object store.
 *
 * Email is intentionally NOT editable here — it's the sign-in
 * identifier and changing it is a destructive operation we don't
 * surface in the self-serve flow.
 */

/** Resize + JPEG-encode an avatar file client-side so we keep the
 *  inline `data:` URL small (~30–80 KB for 256×256 JPEG quality 0.85).
 *  Returns the data URL ready to POST. */
async function compressAvatar(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = reject
      i.src = url
    })
    // Square-crop centered on the longer axis, then resize to 256.
    const side = Math.min(img.naturalWidth, img.naturalHeight)
    const sx = (img.naturalWidth - side) / 2
    const sy = (img.naturalHeight - side) / 2
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 256
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D context unavailable')
    ctx.drawImage(img, sx, sy, side, side, 0, 0, 256, 256)
    return canvas.toDataURL('image/jpeg', 0.85)
  } finally {
    URL.revokeObjectURL(url)
  }
}

function initialsFromUser(user: { name?: string | null; email?: string | null }): string {
  const base = (user.name || user.email || '?').trim()
  if (!base) return '?'
  // Match the sidebar's behaviour — first character of the name (or
  // email if the user hasn't set a name), uppercased.
  return base.charAt(0).toUpperCase()
}

export default function ProfilePage() {
  const { user, loading } = useAuth()

  // --- Profile section state -------------------------------------
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileMsg, setProfileMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const avatarInputRef = useRef<HTMLInputElement | null>(null)

  // --- Security section state ------------------------------------
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)
  const [passwordMsg, setPasswordMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // Seed from the in-context user when it lands. We re-seed any time
  // the user identity changes (e.g. session refresh).
  useEffect(() => {
    if (!user) return
    setName(user.name ?? '')
    setUsername((user as any).username ?? '')
    setAvatarPreview((user as any).avatarUrl ?? null)
  }, [user])

  const handleAvatarPick = useCallback(async (file: File) => {
    setProfileMsg(null)
    try {
      const data = await compressAvatar(file)
      setAvatarPreview(data)
    } catch (err) {
      logError('Avatar compression failed:', err)
      setProfileMsg({ kind: 'err', text: 'Could not process that image. Try another one.' })
    }
  }, [])

  const handleClearAvatar = useCallback(() => {
    setAvatarPreview(null)
  }, [])

  const handleSaveProfile = useCallback(async () => {
    if (!user) return
    setSavingProfile(true)
    setProfileMsg(null)
    try {
      const res = await apiFetch(`/api/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          username: username.trim() || null,
          avatarUrl: avatarPreview, // null clears, data: URL sets
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error || 'Could not save profile')
      }
      setProfileMsg({ kind: 'ok', text: 'Profile updated.' })
    } catch (err) {
      logError('Save profile failed:', err)
      setProfileMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Save failed' })
    } finally {
      setSavingProfile(false)
    }
  }, [user, name, username, avatarPreview])

  const handleSavePassword = useCallback(async () => {
    if (!user) return
    if (!currentPassword) {
      setPasswordMsg({ kind: 'err', text: 'Enter your current password.' })
      return
    }
    // Mirror the server's `validatePassword` rules so users get
    // immediate, actionable feedback instead of a generic 400 after
    // a round-trip. Keep these in sync with `src/lib/encryption.ts`.
    if (newPassword.length < 12) {
      setPasswordMsg({ kind: 'err', text: 'New password must be at least 12 characters.' })
      return
    }
    if (!/[A-Z]/.test(newPassword)) {
      setPasswordMsg({ kind: 'err', text: 'New password needs at least one uppercase letter.' })
      return
    }
    if (!/[a-z]/.test(newPassword)) {
      setPasswordMsg({ kind: 'err', text: 'New password needs at least one lowercase letter.' })
      return
    }
    if (!/[0-9]/.test(newPassword)) {
      setPasswordMsg({ kind: 'err', text: 'New password needs at least one number.' })
      return
    }
    if (!/[^A-Za-z0-9]/.test(newPassword)) {
      setPasswordMsg({ kind: 'err', text: 'New password needs at least one special character (e.g. !@#$%^&*).' })
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordMsg({ kind: 'err', text: 'New passwords don’t match.' })
      return
    }
    setSavingPassword(true)
    setPasswordMsg(null)
    try {
      const res = await apiFetch(`/api/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oldPassword: currentPassword,
          password: newPassword,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error || 'Could not change password')
      }
      setPasswordMsg({ kind: 'ok', text: 'Password changed. You’ll be signed out shortly.' })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      logError('Change password failed:', err)
      setPasswordMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Save failed' })
    } finally {
      setSavingPassword(false)
    }
  }, [user, currentPassword, newPassword, confirmPassword])

  if (loading || !user) return null

  // Reused field-input className — `bg-white/[0.04]` glass surface
  // matching the rest of the v2.5 admin chrome.
  const inputClass =
    'bg-white/[0.04] border-0 ring-1 ring-white/10 text-white placeholder:text-white/40 focus-visible:ring-primary/40'

  return (
    <div className="flex-1 min-h-0">
      <div className="px-3 sm:px-4 lg:px-6 py-3 sm:py-6 max-w-3xl mx-auto space-y-6">
        {/* --- Profile section --- */}
        <section className="rounded-xl bg-white/[0.04] ring-1 ring-white/10 p-5 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] space-y-5">
          <div className="flex items-center gap-2">
            <UserIcon className="w-4 h-4 text-white/55" />
            <h2 className="text-base font-semibold text-white">Profile</h2>
          </div>

          {/* Avatar picker. Remove-photo affordance is now a small X
              button overlaid on the top-right of the avatar (only
              visible when there's actually a photo to clear) so we
              don't need a separate destructive button stacked
              awkwardly beneath "Change photo". */}
          <div className="flex items-center gap-4">
            <div className="relative shrink-0">
              {avatarPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={avatarPreview}
                  alt=""
                  className="w-20 h-20 rounded-full object-cover ring-1 ring-white/10"
                />
              ) : (
                <div className="w-20 h-20 rounded-full bg-primary/15 text-primary ring-1 ring-primary/30 flex items-center justify-center text-3xl font-semibold">
                  {initialsFromUser({ name, email: user.email })}
                </div>
              )}
              {avatarPreview && (
                <button
                  type="button"
                  onClick={handleClearAvatar}
                  className="absolute -top-1 -right-1 inline-flex items-center justify-center w-6 h-6 rounded-full bg-destructive/90 hover:bg-destructive text-white ring-2 ring-[#0d1722] shadow transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive/60"
                  aria-label="Remove photo"
                  title="Remove photo"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void handleAvatarPick(file)
                // Reset so picking the same file again still fires onChange.
                e.target.value = ''
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => avatarInputRef.current?.click()}
              className="bg-white/[0.06] hover:bg-white/[0.12] ring-1 ring-white/10 text-white border-0"
            >
              <Camera className="w-4 h-4 mr-2" />
              Change photo
            </Button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="profile-name" className="text-white/80">Display name</Label>
              <Input
                id="profile-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your full name"
                className={inputClass}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profile-username" className="text-white/80">Username</Label>
              <Input
                id="profile-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="username"
                className={inputClass}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            {profileMsg ? (
              <span
                className={`text-xs ${
                  profileMsg.kind === 'ok' ? 'text-emerald-400' : 'text-destructive'
                }`}
              >
                {profileMsg.text}
              </span>
            ) : (
              <span />
            )}
            <Button
              type="button"
              onClick={handleSaveProfile}
              disabled={savingProfile}
              style={{ color: '#ffffff' }}
              className="font-semibold"
            >
              {savingProfile ? 'Saving…' : (
                <>
                  <Check className="w-4 h-4 mr-2" />
                  Save profile
                </>
              )}
            </Button>
          </div>
        </section>

        {/* --- Security section --- */}
        <section className="rounded-xl bg-white/[0.04] ring-1 ring-white/10 p-5 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] space-y-5">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-white/55" />
            <h2 className="text-base font-semibold text-white">Password</h2>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="security-current" className="text-white/80">Current password</Label>
            <Input
              id="security-current"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              className={inputClass}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="security-new" className="text-white/80">New password</Label>
              <Input
                id="security-new"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                className={inputClass}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="security-confirm" className="text-white/80">Confirm new password</Label>
              <Input
                id="security-confirm"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                className={inputClass}
              />
            </div>
          </div>
          <p className="text-xs text-white/55">
            Must be at least 12 characters, with an uppercase letter, a
            lowercase letter, a number, and a special character. Changing
            your password signs out every active session — you&apos;ll need
            to sign back in.
          </p>

          <div className="flex items-center justify-between gap-3">
            {passwordMsg ? (
              <span
                className={`text-xs ${
                  passwordMsg.kind === 'ok' ? 'text-emerald-400' : 'text-destructive'
                }`}
              >
                {passwordMsg.text}
              </span>
            ) : (
              <span />
            )}
            <Button
              type="button"
              onClick={handleSavePassword}
              disabled={savingPassword}
              style={{ color: '#ffffff' }}
              className="font-semibold"
            >
              {savingPassword ? 'Saving…' : (
                <>
                  <Check className="w-4 h-4 mr-2" />
                  Change password
                </>
              )}
            </Button>
          </div>
        </section>
      </div>
    </div>
  )
}
