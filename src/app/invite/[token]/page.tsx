'use client'

/**
 * 5.6 multi-tenant Phase 4: public invite-acceptance page.
 *
 * Mirrors the register page's look. Loads the invite info (company + role),
 * then lets the invitee set name/email/password. POST /accept creates the
 * account inside the inviting company, signs them in (same token shape as
 * login/register) and lands them in /admin/projects.
 */

import { useEffect, useState, Suspense } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'
import { Users, UserPlus, Loader2, Clock } from 'lucide-react'
import { setTokens, clearTokens } from '@/lib/token-store'
import { ROLE_LABELS } from '@/lib/permissions'
import WordMark from '@/components/WordMark'

interface InviteInfo {
  companyName: string
  role: string
  expiresAt: string
}

function InviteForm() {
  const router = useRouter()
  const params = useParams()
  const token = (params?.token as string) || ''

  const [info, setInfo] = useState<InviteInfo | null>(null)
  const [infoError, setInfoError] = useState('')
  const [loadingInfo, setLoadingInfo] = useState(true)

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await fetch(`/api/invite/${encodeURIComponent(token)}`, { cache: 'no-store' })
        const data = await res.json().catch(() => ({}))
        if (!alive) return
        if (!res.ok) {
          setInfoError(
            res.status === 410
              ? data.error || 'This invite link is no longer valid.'
              : 'This invite link is invalid. Ask for a fresh one.',
          )
        } else {
          setInfo(data)
        }
      } catch {
        if (alive) setInfoError('Failed to load the invite. Please try again.')
      } finally {
        if (alive) setLoadingInfo(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [token])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const response = await fetch(`/api/invite/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      })
      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        setError(data.error || 'Failed to join. Please try again.')
        setLoading(false)
        return
      }

      if (data?.tokens?.accessToken) {
        setTokens({
          accessToken: data.tokens.accessToken,
        })
      } else {
        clearTokens()
      }

      router.push('/admin/projects')
      router.refresh()
    } catch {
      setError('Failed to join. Please try again.')
      setLoading(false)
    }
  }

  const roleLabel = info ? (ROLE_LABELS as Record<string, string>)[info.role] || info.role : ''

  return (
    <div className="flex-1 min-h-0 bg-background flex flex-col">
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <WordMark variant="stacked" iconSize={64} className="mx-auto mb-4" ariaHidden />
            <h1 className="sr-only">FrameComment</h1>
            <p className="text-sm text-muted-foreground mt-2">
              Join your team on FrameComment
            </p>
          </div>

          <Card>
            {loadingInfo ? (
              <CardContent className="py-10 flex items-center justify-center gap-3 text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin" />
                <span className="text-sm">Checking your invite…</span>
              </CardContent>
            ) : infoError ? (
              <CardContent className="py-8 text-center space-y-3">
                <div className="mx-auto rounded-full bg-amber-500/10 p-3 w-fit">
                  <Clock className="w-6 h-6 text-amber-500" />
                </div>
                <h2 className="text-lg font-semibold">Can&apos;t use this invite</h2>
                <p className="text-sm text-muted-foreground">{infoError}</p>
                <p className="text-sm text-muted-foreground">
                  Already have an account?{' '}
                  <Link
                    href="/login"
                    className="text-foreground underline underline-offset-4 hover:text-primary transition-colors"
                  >
                    Sign in
                  </Link>
                </p>
              </CardContent>
            ) : (
              <>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Users className="w-5 h-5" />
                    Join {info?.companyName}
                  </CardTitle>
                  <CardDescription>
                    You&apos;ve been invited as <span className="text-foreground font-medium">{roleLabel}</span>.
                    Create your account to get started.
                  </CardDescription>
                </CardHeader>

                <CardContent>
                  <form onSubmit={handleSubmit} className="space-y-4">
                    {error && (
                      <div className="p-3 bg-destructive-visible border-2 border-destructive-visible rounded-lg">
                        <p className="text-sm text-destructive font-medium">{error}</p>
                      </div>
                    )}

                    <div className="space-y-2">
                      <Label htmlFor="name">Your name</Label>
                      <Input
                        id="name"
                        type="text"
                        placeholder="Jane Doe"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        required
                        autoFocus
                        autoComplete="name"
                        disabled={loading}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="email">Email</Label>
                      <Input
                        id="email"
                        type="email"
                        placeholder="jane@example.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                        autoComplete="email"
                        disabled={loading}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="password">Password</Label>
                      <PasswordInput
                        id="password"
                        placeholder="At least 10 characters"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        autoComplete="new-password"
                        disabled={loading}
                      />
                    </div>

                    <Button
                      type="submit"
                      variant="default"
                      size="default"
                      className="w-full"
                      disabled={loading}
                    >
                      <UserPlus className="w-4 h-4 mr-2" />
                      {loading ? 'Joining…' : `Join ${info?.companyName}`}
                    </Button>

                    <p className="text-center text-sm text-muted-foreground">
                      Already have an account?{' '}
                      <Link
                        href="/login"
                        className="text-foreground underline underline-offset-4 hover:text-primary transition-colors"
                      >
                        Sign in
                      </Link>
                    </p>
                  </form>
                </CardContent>
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}

export default function InvitePage() {
  return (
    <Suspense
      fallback={
        <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
          <div className="text-center">
            <WordMark variant="stacked" iconSize={64} className="mx-auto mb-4 animate-pulse" ariaHidden />
          </div>
        </div>
      }
    >
      <InviteForm />
    </Suspense>
  )
}
