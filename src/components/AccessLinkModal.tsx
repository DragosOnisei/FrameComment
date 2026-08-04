'use client'

/**
 * 5.16 — "Access link" modal (PLATFORM OWNER ONLY, User Management).
 *
 * Mirrors the InviteLinkModal look & flow, but for inviting NEW COMPANIES:
 * Create link → a single-use /register?code=… URL (30 days) shown with
 * auto-copy + a Copy button, and below it the list of generated links with
 * their status (active / used by whom / expired) and revoke for unused ones.
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
import { KeyRound, Copy, Check, Trash2, Loader2, Clock } from 'lucide-react'
import { copyToClipboard } from '@/lib/clipboard'
import { apiFetch, apiPost } from '@/lib/api-client'

interface AccessInvite {
  id: string
  code: string
  createdAt: string
  expiresAt: string
  usedAt: string | null
  usedByEmail: string | null
}

interface AccessLinkModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function linkFor(code: string): string {
  return `${window.location.origin}/register?code=${encodeURIComponent(code)}`
}

export default function AccessLinkModal({ open, onOpenChange }: AccessLinkModalProps) {
  const [creating, setCreating] = useState(false)
  const [createdLink, setCreatedLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [invites, setInvites] = useState<AccessInvite[]>([])
  const [loadingList, setLoadingList] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [copiedRowId, setCopiedRowId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const loadInvites = useCallback(async () => {
    try {
      setLoadingList(true)
      const res = await apiFetch('/api/platform/access-links')
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
      loadInvites()
    }
  }, [open, loadInvites])

  async function handleCreate() {
    if (creating) return
    try {
      setCreating(true)
      setError('')
      setCreatedLink(null)
      setCopied(false)
      const data = await apiPost<{ path?: string }>('/api/platform/access-links', {})
      if (!data?.path) {
        setError('Failed to create access link.')
        return
      }
      const url = `${window.location.origin}${data.path}`
      setCreatedLink(url)
      // Auto-copy — same convenience as the invite modal.
      const ok = await copyToClipboard(url)
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 2500)
      }
      loadInvites()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create access link.')
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

  async function handleCopyRow(invite: AccessInvite) {
    const ok = await copyToClipboard(linkFor(invite.code))
    if (ok) {
      setCopiedRowId(invite.id)
      setTimeout(() => setCopiedRowId(null), 2000)
    }
  }

  async function handleRevoke(id: string) {
    try {
      setRevokingId(id)
      const res = await apiFetch(`/api/platform/access-links?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error('revoke failed')
      setInvites((prev) => prev.filter((i) => i.id !== id))
    } catch {
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
            <KeyRound className="w-5 h-5" />
            Access link
          </DialogTitle>
          <DialogDescription className="text-white/60">
            Invite a new company to FrameComment. Each link creates one
            company, works exactly once, and expires after 30 days.
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

          <Button onClick={handleCreate} disabled={creating} className="w-full">
            {creating ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <KeyRound className="w-4 h-4 mr-2" />
            )}
            Create link
          </Button>

          {createdLink && (
            <div className="space-y-1.5">
              <Label className="text-white/80">Access link</Label>
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0 h-9 rounded-md bg-white/[0.06] ring-1 ring-white/10 px-3 flex items-center">
                  <span className="text-sm text-white/85 truncate">{createdLink}</span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0 ring-1 ring-white/10 text-white/80 hover:text-white hover:bg-white/10"
                  onClick={handleCopy}
                  aria-label="Copy access link"
                >
                  {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
              <p className="text-xs text-white/50">
                Send it to the company, they&apos;ll set their company name,
                owner account and password.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-white/80">Generated links</Label>
            {loadingList ? (
              <div className="flex items-center gap-2 text-sm text-white/50 py-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : invites.length === 0 ? (
              <p className="text-sm text-white/45 py-1">No access links yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {invites.map((invite) => {
                  const used = !!invite.usedAt
                  const expired = !used && new Date(invite.expiresAt).getTime() <= Date.now()
                  return (
                    <li
                      key={invite.id}
                      className="flex items-center gap-2 rounded-md bg-white/[0.04] ring-1 ring-white/10 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-white/85 truncate font-mono">
                          {invite.code}
                        </p>
                        {used ? (
                          <p className="text-xs text-emerald-300/90 flex items-center gap-1">
                            <Check className="w-3 h-3" />
                            used{invite.usedByEmail ? ` by ${invite.usedByEmail}` : ''} ·{' '}
                            {new Date(invite.usedAt as string).toLocaleDateString()}
                          </p>
                        ) : (
                          <p className={`text-xs flex items-center gap-1 ${expired ? 'text-red-300/80' : 'text-white/45'}`}>
                            <Clock className="w-3 h-3" />
                            {expiresLabel(invite.expiresAt)}
                          </p>
                        )}
                      </div>
                      {!used && !expired && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0 text-white/55 hover:text-white hover:bg-white/10"
                          onClick={() => void handleCopyRow(invite)}
                          aria-label="Copy this access link"
                        >
                          {copiedRowId === invite.id ? (
                            <Check className="w-4 h-4 text-emerald-400" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </Button>
                      )}
                      {!used && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0 text-white/55 hover:text-red-300 hover:bg-red-500/10"
                          onClick={() => void handleRevoke(invite.id)}
                          disabled={revokingId === invite.id}
                          aria-label="Revoke access link"
                        >
                          {revokingId === invite.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Trash2 className="w-4 h-4" />
                          )}
                        </Button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
