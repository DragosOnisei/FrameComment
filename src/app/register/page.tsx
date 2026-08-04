'use client'

/**
 * 5.0 multi-tenant: public company registration (private beta).
 *
 * Mirrors the login page's look. Creates the Organization + its first OWNER
 * via POST /api/auth/register, stores the returned tokens (same shape as
 * login) and lands the new owner straight in /admin/projects.
 *
 * The invite-code field backs the private-beta gate: the server only accepts
 * registrations whose code matches the REGISTER_INVITE_CODE env var, and the
 * whole endpoint is disabled when that env is unset.
 */

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'
import { Building2, UserPlus } from 'lucide-react'
import { setTokens, clearTokens } from '@/lib/token-store'
import WordMark from '@/components/WordMark'

function RegisterForm() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [companyName, setCompanyName] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')

  // 5.14: access links land here as /register?code=… — pre-fill the
  // invite-code field so the invited company just fills in their details.
  useEffect(() => {
    const code = searchParams?.get('code')
    if (code) setInviteCode(code)
  }, [searchParams])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyName, name, email, password, inviteCode }),
      })

      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        setError(
          response.status === 404
            ? 'Registration is not open yet. Ask for an invite.'
            : data.error || 'Registration failed. Please try again.',
        )
        setLoading(false)
        return
      }

      if (data?.tokens?.accessToken && data?.tokens?.refreshToken) {
        setTokens({
          accessToken: data.tokens.accessToken,
          refreshToken: data.tokens.refreshToken,
        })
      } else {
        clearTokens()
      }

      router.push('/admin/projects')
      router.refresh()
    } catch {
      setError('Registration failed. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div className="flex-1 min-h-0 bg-background flex flex-col">
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <WordMark variant="stacked" iconSize={64} className="mx-auto mb-4" ariaHidden />
            <h1 className="sr-only">FrameComment</h1>
            <p className="text-sm text-muted-foreground mt-2">
              Create your company workspace
            </p>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Building2 className="w-5 h-5" />
                Create your company
              </CardTitle>
              <CardDescription>
                You&apos;ll be the owner and can invite your team afterwards.
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
                  <Label htmlFor="companyName">Company name</Label>
                  <Input
                    id="companyName"
                    type="text"
                    placeholder="Acme Studio"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    required
                    autoFocus
                    disabled={loading}
                  />
                  <p className="text-xs text-muted-foreground">
                    You can change this later in Settings.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="name">Your name</Label>
                  <Input
                    id="name"
                    type="text"
                    placeholder="Jane Doe"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    autoComplete="name"
                    disabled={loading}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="jane@acme.com"
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

                <div className="space-y-2">
                  <Label htmlFor="inviteCode">Invite code</Label>
                  <Input
                    id="inviteCode"
                    type="text"
                    placeholder="Your private-beta invite code"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    required
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
                  {loading ? 'Creating your company…' : 'Create company'}
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
          </Card>
        </div>
      </div>
    </div>
  )
}

export default function RegisterPage() {
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
      <RegisterForm />
    </Suspense>
  )
}
