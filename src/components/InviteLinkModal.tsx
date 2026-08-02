'use client'

/**
 * 5.6 multi-tenant Phase 4: "Invite with link" modal (User Management).
 *
 * Owner/Admin picks a role → the server mints a single-use, 7-day link →
 * shown here exactly ONCE (only its hash is stored server-side) with a Copy
 * button. Below: the org's pending invites, each revocable instantly.
 */

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Link2, Copy, Check, Trash2, Loader2, Clock } from 'lucide-react'
import { copyToClipboard } from '@/lib/clipboard'
import { apiDelete, apiFetch, apiPost } from '@/lib/api-client'
import {
  canAssignRole,
  roleLevel,
  ROLE_LABELS,
  ASSIGNABLE_ROLES,
  type AppRole,
} from '@/lib/permissions'

interface PendingInvite {
  id: string
  role: string
  invitedByName: string | null
  expiresAt: string
  createdAt: string
}

interface InviteLinkModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The logged-in user's role — caps the assignable-roles dropdown. */
  myRole: string
}

export default function InviteLinkModal({ open, onOpenChange, myRole }: InviteLinkModalProps) {
  const assignableRoles = ASSIGNABLE_ROLES
    .filter((r) => canAssignRole(myRole, r))
    .sort((a, b) => roleLevel(b) - roleLevel(a))
  const roleLabel = (role: string): string =>
    (ROLE_LABELS as Record<string, string>)[role] || role

  const [role, setRole] = useState<AppRole | ''>('')
  const [creating, setCreating] = useState(false)
  const [createdLink, setCreatedLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [invites, setInvites] = useState<PendingInvite[]>([])
  const [loadingList, setLoadingList] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const loadInvites = useCallback(async () => {
    try {
      setLoadingList(true)
      const res = await apiFetch('/api/team-invites')
      if (res.ok) {
        const data = await res.json()
        setInvites(Array.isArray(data.invites) ? data.invites : [])
      }
    } catch {
      // list is best-effort; creation/revocation surface their own errors
    } finally {
      setLoadingList(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      setError('')
      setCreatedLink(null)
      setCopied(false)
      if (!role && assignableRoles.length > 0) setRole(assignableRoles[assignableRoles.length - 1])
      loadInvites()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loadInvites])

  async function handleCreate() {
    if (!role || creating) return
    try {
      setCreating(true)
      setError('')
      setCreatedLink(null)
      setCopied(false)
      // apiPost returns the PARSED JSON and throws on any non-ok status.
      const data = await apiPost<{ path?: string }>('/api/team-invites', { role })
      if (!data?.path) {
        setError('Failed to create invite link.')
        return
      }
      const url = `${window.location.origin}${data.path}`
      setCreatedLink(url)
      // Auto-copy — same convenience as the share modal.
      const ok = await copyToClipboard(url)
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 2500)
      }
      loadInvites()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create invite link.')
    } finally {
      setCreating(false)
    }
  }

  async function handleCopy() {
    if (!createdLink) return
    const ok = await copyToClipboard(createdLink)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    }
  }

  async function handleRevoke(id: string) {
    try {
      setRevokingId(id)
      // apiDelete throws on non-ok; success means the row is gone.
      await apiDelete(`/api/team-invites/${id}`)
      setInvites((prev) => prev.filter((i) => i.id !== id))
    } catch {
      // Already revoked/expired elsewhere — re-sync the list instead of erroring.
      loadInvites()
    } finally {
      setRevokingId(null)
    }
  }

  function expiresLabel(expiresAt: string): string {
    const ms = new Date(expiresAt).getTime() - Date.now()
    if (ms <= 0) return 'expired'
    const days = Math.floor(ms / (24 * 60 * 60 * 1000))
    if (days >= 1) return `expires in ${days} ${days === 1 ? 'day' : 'days'}`
    const hours = Math.max(1, Math.floor(ms / (60 * 60 * 1000)))
    return `expires in ${hours} ${hours === 1 ? 'hour' : 'hours'}`
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        overlayClassName="bg-transparent"
        className="sm:max-w-md max-h-[90vh] flex flex-col bg-white/[0.06] text-white ring-1 ring-white/10 border-0 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.7)]"
        style={{
          backdropFilter: 'blur(20px) saturate(140%)',
          WebkitBackdropFilter: 'blur(20px) saturate(140%)',
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="w-5 h-5" />
            Invite with link
          </DialogTitle>
          <DialogDescription className="text-white/60">
            Anyone with the link can join your company with the selected role.
            Links are single-use and expire after 7 days.
          </DialogDescription>
        </DialogHeader>

        {/* px-1 -mx-1: the ring-1 outlines are box-shadows that the scroll
            container would otherwise clip at the left/right edges. */}
        <div className="space-y-4 overflow-y-auto min-h-0 px-1 -mx-1">
          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 ring-1 ring-red-500/30">
              <p className="text-sm text-red-300">{error}</p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="invite-role" className="text-white/80">Role</Label>
            <div className="flex items-center gap-2">
              <select
                id="invite-role"
                value={role}
                onChange={(e) => setRole(e.target.value as AppRole)}
                disabled={creating}
                className="flex-1 h-9 rounded-md bg-white/[0.06] ring-1 ring-white/10 border-0 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-white/30"
              >
                {assignableRoles.map((r) => (
                  <option key={r} value={r} className="bg-neutral-900 text-white">
                    {roleLabel(r)}
                  </option>
                ))}
              </select>
              <Button onClick={handleCreate} disabled={creating || !role} className="shrink-0">
                {creating ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Link2 className="w-4 h-4 mr-2" />
                )}
                Create link
              </Button>
            </div>
          </div>

          {createdLink && (
            <div className="space-y-1.5">
              <Label className="text-white/80">Invite link (shown only once)</Label>
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0 h-9 rounded-md bg-white/[0.06] ring-1 ring-white/10 px-3 flex items-center">
                  <span className="text-sm text-white/85 truncate">{createdLink}</span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0 ring-1 ring-white/10 text-white/80 hover:text-white hover:bg-white/10"
                  onClick={handleCopy}
                  aria-label="Copy invite link"
                >
                  {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
              <p className="text-xs text-white/50">
                Send it to your team member — they&apos;ll set their name, email and password.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-white/80">Pending invites</Label>
            {loadingList ? (
              <div className="flex items-center gap-2 text-sm text-white/50 py-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : invites.length === 0 ? (
              <p className="text-sm text-white/45 py-1">No active invite links.</p>
            ) : (
              <ul className="space-y-1.5">
                {invites.map((invite) => (
                  <li
                    key={invite.id}
                    className="flex items-center gap-2 rounded-md bg-white/[0.04] ring-1 ring-white/10 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-white/85 truncate">
                        {roleLabel(invite.role)}
                        {invite.invitedByName ? (
                          <span className="text-white/45"> · by {invite.invitedByName}</span>
                        ) : null}
                      </p>
                      <p className="text-xs text-white/45 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {expiresLabel(invite.expiresAt)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0 text-white/55 hover:text-red-300 hover:bg-red-500/10"
                      onClick={() => handleRevoke(invite.id)}
                      disabled={revokingId === invite.id}
                      aria-label="Revoke invite"
                    >
                      {revokingId === invite.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
