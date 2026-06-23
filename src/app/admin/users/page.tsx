'use client'

import { useEffect, useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from '@/components/ui/dialog'
import { Users, UserPlus, Edit, Trash2, Mail, Search, RefreshCw, AlertCircle, Eye, EyeOff, Copy, Check, KeyRound, Fingerprint, Plus } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { TopbarLeftSlot, TopbarRightSlot } from '@/components/TopbarSlots'
import { copyToClipboard } from '@/lib/clipboard'
import { apiDelete, apiFetch, apiPost, apiPatch } from '@/lib/api-client'
import { PasswordRequirements } from '@/components/PasswordRequirements'
import { startRegistration } from '@simplewebauthn/browser'
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser'

interface UserData {
  id: string
  email: string
  username: string | null
  name: string | null
  role: string
  createdAt: string
  updatedAt: string
  // 3.2.x: profile avatar (inline data: URL). Shown in the list row;
  // falls back to an initials disc when absent.
  avatarUrl?: string | null
}

export default function UsersPage() {
  const t = useTranslations('users')
  const tc = useTranslations('common')
  const [users, setUsers] = useState<UserData[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [loggedInUser, setLoggedInUser] = useState<UserData | null>(null)

  // Modal states
  const [showAddUserModal, setShowAddUserModal] = useState(false)
  const [showEditUserModal, setShowEditUserModal] = useState(false)
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [showPasskeyModal, setShowPasskeyModal] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // Form states
  const [editingUser, setEditingUser] = useState<UserData | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<UserData | null>(null)

  // New user form
  const [newUserData, setNewUserData] = useState({
    email: '',
    username: '',
    name: '',
    password: '',
    confirmPassword: '',
  })

  // Edit user form
  const [editFormData, setEditFormData] = useState({
    email: '',
    username: '',
    name: '',
  })

  // Password form
  const [passwordData, setPasswordData] = useState({
    oldPassword: '',
    password: '',
    confirmPassword: '',
  })
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [copiedPassword, setCopiedPassword] = useState(false)

  // Passkey state
  const [passkeys, setPasskeys] = useState<any[]>([])
  const [passkeyAvailable, setPasskeyAvailable] = useState(false)

  // Action states
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const fetchUsers = useCallback(async () => {
    try {
      const res = await apiFetch('/api/users')
      if (!res.ok) throw new Error('Failed to fetch users')
      const data = await res.json()
      setUsers(data.users)
    } catch (err) {
      setError(t('failedToLoadUsers'))
    } finally {
      setLoading(false)
    }
  }, [t])

  const fetchLoggedInUser = useCallback(async () => {
    try {
      const res = await apiFetch('/api/auth/session')
      if (res.ok) {
        const data = await res.json()
        setLoggedInUser(data.user)
      }
    } catch (err) {
      // Silently fail
    }
  }, [])

  const fetchPasskeyStatus = useCallback(async () => {
    try {
      const res = await apiFetch('/api/auth/passkey/status')
      if (res.ok) {
        const data = await res.json()
        setPasskeyAvailable(data.available)
      }
    } catch (err) {
      // Silently fail
    }
  }, [])

  const fetchPasskeys = useCallback(async (userId: string) => {
    try {
      const res = await apiFetch(`/api/auth/passkey/list?userId=${userId}`)
      if (res.ok) {
        const data = await res.json()
        setPasskeys(data.passkeys || [])
      }
    } catch (err) {
      // Silently fail
    }
  }, [])

  useEffect(() => {
    fetchUsers()
    fetchLoggedInUser()
    fetchPasskeyStatus()
  }, [fetchUsers, fetchLoggedInUser, fetchPasskeyStatus])

  // Filter users by search
  const filteredUsers = users.filter(user => {
    if (!searchQuery) return true
    const query = searchQuery.toLowerCase()
    return (
      user.email.toLowerCase().includes(query) ||
      user.name?.toLowerCase().includes(query) ||
      user.username?.toLowerCase().includes(query)
    )
  })

  // Password generation
  const generateRandomPassword = (forNewUser = false) => {
    const length = 16
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    const lowercase = 'abcdefghijklmnopqrstuvwxyz'
    const numbers = '0123456789'
    const special = '!@#$%^&*'
    const all = uppercase + lowercase + numbers + special

    const getRandomInt = (max: number) => {
      const array = new Uint32Array(1)
      crypto.getRandomValues(array)
      return array[0] % max
    }

    let password = ''
    password += uppercase[getRandomInt(uppercase.length)]
    password += lowercase[getRandomInt(lowercase.length)]
    password += numbers[getRandomInt(numbers.length)]
    password += special[getRandomInt(special.length)]

    for (let i = password.length; i < length; i++) {
      password += all[getRandomInt(all.length)]
    }

    const chars = password.split('')
    for (let i = chars.length - 1; i > 0; i--) {
      const j = getRandomInt(i + 1)
      ;[chars[i], chars[j]] = [chars[j], chars[i]]
    }
    password = chars.join('')

    if (forNewUser) {
      setNewUserData(prev => ({ ...prev, password, confirmPassword: password }))
    } else {
      setPasswordData(prev => ({ ...prev, password, confirmPassword: password }))
    }
    setShowPassword(true)
    setShowConfirmPassword(true)
  }

  const copyPassword = async (password: string) => {
    await copyToClipboard(password)
    setCopiedPassword(true)
    setTimeout(() => setCopiedPassword(false), 2000)
  }

  // Add user
  async function handleAddUser() {
    if (!newUserData.email || !newUserData.password) {
      setError(t('emailAndPasswordRequired'))
      return
    }
    if (newUserData.password !== newUserData.confirmPassword) {
      setError(t('passwordsDoNotMatch'))
      return
    }

    setSaving(true)
    setError('')

    try {
      await apiPost('/api/users', {
        email: newUserData.email,
        username: newUserData.username || undefined,
        name: newUserData.name || undefined,
        password: newUserData.password,
      })
      await fetchUsers()
      setNewUserData({ email: '', username: '', name: '', password: '', confirmPassword: '' })
      setShowAddUserModal(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToCreateUser'))
    } finally {
      setSaving(false)
    }
  }

  // Edit user
  function openEditModal(user: UserData) {
    setEditingUser(user)
    setEditFormData({
      email: user.email,
      username: user.username || '',
      name: user.name || '',
    })
    setError('')
    setShowEditUserModal(true)
  }

  async function handleEditUser() {
    if (!editingUser || !editFormData.email) {
      setError(t('emailIsRequired'))
      return
    }

    setSaving(true)
    setError('')

    try {
      await apiPatch(`/api/users/${editingUser.id}`, {
        email: editFormData.email,
        username: editFormData.username || null,
        name: editFormData.name || null,
      })
      await fetchUsers()
      setShowEditUserModal(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToUpdateUser'))
    } finally {
      setSaving(false)
    }
  }

  // Change password
  function openPasswordModal(user: UserData) {
    setEditingUser(user)
    setPasswordData({ oldPassword: '', password: '', confirmPassword: '' })
    setShowPassword(false)
    setShowConfirmPassword(false)
    setError('')
    setShowPasswordModal(true)
  }

  async function handleChangePassword() {
    if (!editingUser) return

    if (!passwordData.oldPassword) {
      setError(t('currentPasswordRequired'))
      return
    }
    if (!passwordData.password) {
      setError(t('newPasswordRequired'))
      return
    }
    if (passwordData.password !== passwordData.confirmPassword) {
      setError(t('passwordsDoNotMatch'))
      return
    }

    setSaving(true)
    setError('')

    try {
      await apiPatch(`/api/users/${editingUser.id}`, {
        oldPassword: passwordData.oldPassword,
        password: passwordData.password,
      })
      setShowPasswordModal(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToChangePassword'))
    } finally {
      setSaving(false)
    }
  }

  // Passkeys
  function openPasskeyModal(user: UserData) {
    setEditingUser(user)
    setError('')
    fetchPasskeys(user.id)
    setShowPasskeyModal(true)
  }

  async function handleRegisterPasskey() {
    if (!editingUser) return

    setError('')
    setSaving(true)

    try {
      const options: PublicKeyCredentialCreationOptionsJSON = await apiPost('/api/auth/passkey/register/options', {})
      const attestation = await startRegistration({ optionsJSON: options })
      await apiPost('/api/auth/passkey/register/verify', attestation)
      await fetchPasskeys(editingUser.id)
    } catch (err: any) {
      if (err.name === 'NotAllowedError') {
        setError(t('cancelledOrTimedOut'))
      } else if (err.name === 'InvalidStateError') {
        setError(t('alreadyRegistered'))
      } else {
        setError(t('failedToRegisterPasskey'))
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleDeletePasskey(passkeyId: string) {
    if (!editingUser || !confirm(t('deletePasskeyConfirm'))) return

    try {
      await apiDelete(`/api/auth/passkey/${passkeyId}?userId=${editingUser.id}`)
      await fetchPasskeys(editingUser.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToDeletePasskey'))
    }
  }

  // Delete user
  function confirmDelete(user: UserData) {
    setDeleteTarget(user)
    setError('')
    setShowDeleteConfirm(true)
  }

  async function handleDelete() {
    if (!deleteTarget) return

    setSaving(true)
    setError('')

    try {
      await apiDelete(`/api/users/${deleteTarget.id}`)
      await fetchUsers()
      setShowDeleteConfirm(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToDeleteUser'))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex-1 min-h-0">
        <div className="px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
          <div className="flex items-center justify-center h-64">
            <RefreshCw className="w-6 h-6 animate-spin text-white/55" />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0">
      {/* 2.5.0+: title + primary action portalled into the
          AdminTopBar slots — same pattern as the Projects page. */}
      <TopbarLeftSlot>
        <Users size={20} className="text-primary shrink-0" />
        <h1
          className="font-semibold truncate"
          style={{ fontSize: 18, lineHeight: '24px' }}
        >
          {t('title')}
        </h1>
      </TopbarLeftSlot>
      <TopbarRightSlot>
        <Button
          variant="ghost"
          size="sm"
          className="sm:h-9 sm:px-3 ring-1 ring-white/10 text-white hover:text-white"
          style={{
            backgroundColor: 'rgba(255,255,255,0.06)',
            backdropFilter: 'blur(12px) saturate(140%)',
            WebkitBackdropFilter: 'blur(12px) saturate(140%)',
          }}
          onClick={() => {
            setNewUserData({ email: '', username: '', name: '', password: '', confirmPassword: '' })
            setShowPassword(false)
            setShowConfirmPassword(false)
            setError('')
            setShowAddUserModal(true)
          }}
          aria-label={t('addUser')}
        >
          <UserPlus className="w-4 h-4 sm:mr-2" />
          <span className="hidden sm:inline">{t('addUser')}</span>
        </Button>
      </TopbarRightSlot>

      <div className="px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
        {/* 2.5.0+: subtitle stays just under the search since the
            title moved to the topbar. */}
        <p className="text-sm text-white/55 mb-4">{t('description')}</p>

        {/* Search — frosted-glass input matching the projects
            table's design vocabulary. */}
        <div className="mb-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/55 pointer-events-none z-10" />
            <Input
              placeholder={t('searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 bg-white/[0.04] border-white/10 text-white placeholder:text-white/45 focus-visible:ring-primary/60"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-form-type="other"
              data-lpignore="true"
              data-1p-ignore
            />
          </div>
        </div>

        {/* Users List */}
        {filteredUsers.length === 0 ? (
          <div className="text-center py-12 text-white/55">
            <Users className="w-12 h-12 mx-auto mb-4 opacity-40" />
            <p className="font-medium text-white">{t('noUsers')}</p>
            <p className="text-sm mt-1">
              {searchQuery ? t('noUsersSearch') : t('noUsersHint')}
            </p>
          </div>
        ) : (
          // 2.5.0+: each row is a floating frosted-glass card with
          // the same recipe as the projects table — `#13181d` at 65 %
          // with backdrop-blur + a hairline white-10 ring, plus a
          // subtle drop shadow so the rows read as elevated tiles
          // against the spotlight wash.
          <div className="space-y-2">
            {filteredUsers.map((user) => (
              <div
                key={user.id}
                // 2.5.0+: true frosted-glass row — white-tint film
                // (same recipe as the sidebar / topbar surfaces in
                // dark mode) + inline backdrop-filter so the blur
                // is guaranteed to land. The spotlight wash and
                // grid behind bleed through clearly.
                className="flex items-center justify-between p-3 rounded-xl bg-white/[0.04] ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] hover:bg-white/[0.07] transition-colors"
                style={{
                  backdropFilter: 'blur(20px) saturate(140%)',
                  WebkitBackdropFilter: 'blur(20px) saturate(140%)',
                }}
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  {/* 3.2.x: show the admin's profile picture (inline
                      data: URL) when set — same as the sidebar account
                      chip — instead of a generic icon. Falls back to an
                      initials disc. */}
                  {user.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={user.avatarUrl}
                      alt={user.name || user.username || user.email}
                      className="w-9 h-9 rounded-full object-cover ring-1 ring-white/10 shrink-0"
                    />
                  ) : (
                    <div className="w-9 h-9 rounded-full bg-primary/15 text-primary ring-1 ring-primary/30 flex items-center justify-center font-medium text-sm shrink-0">
                      {(user.name || user.username || user.email || '?').trim().charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium truncate text-white">{user.name || user.username || user.email}</p>
                      <span className="px-2 py-0.5 text-xs rounded-full bg-primary/15 text-primary ring-1 ring-primary/30 flex-shrink-0">
                        {t('admin')}
                      </span>
                      {loggedInUser?.id === user.id && (
                        <span className="px-2 py-0.5 text-xs rounded-full bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30 flex-shrink-0">
                          {t('you')}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-white/55 mt-0.5">
                      <span className="flex items-center gap-1">
                        <Mail className="w-3 h-3" />
                        <span className="truncate">{user.email}</span>
                      </span>
                      {user.username && (
                        <span>@{user.username}</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-0.5 sm:gap-1 ml-2 flex-shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-white/65 hover:text-white hover:bg-white/5"
                    onClick={() => openEditModal(user)}
                    title={t('editUser')}
                  >
                    <Edit className="w-4 h-4" />
                  </Button>
                  {loggedInUser?.id === user.id && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-white/65 hover:text-white hover:bg-white/5"
                      onClick={() => openPasswordModal(user)}
                      title={t('changePassword')}
                    >
                      <KeyRound className="w-4 h-4" />
                    </Button>
                  )}
                  {passkeyAvailable && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-white/65 hover:text-white hover:bg-white/5"
                      onClick={() => openPasskeyModal(user)}
                      title={t('managePasskeys')}
                    >
                      <Fingerprint className="w-4 h-4" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => confirmDelete(user)}
                    className="h-8 w-8 text-red-400 hover:text-red-300 hover:bg-red-500/10"
                    title={t('deleteUser')}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add User Modal — 2.5.1+ glass refresh. Same recipe as
          NewFolderDialog / ConfirmModal so all three dialogs read as
          one family: transparent backdrop (no black wash), frosted
          glass shell, white text hierarchy, brand-blue primary
          button. */}
      <Dialog open={showAddUserModal} onOpenChange={setShowAddUserModal}>
        <DialogContent
          overlayClassName="bg-transparent"
          className="sm:max-w-md max-h-[90vh] flex flex-col bg-white/[0.06] text-white ring-1 ring-white/10 border-0 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.7)]"
          style={{
            backdropFilter: 'blur(20px) saturate(140%)',
            WebkitBackdropFilter: 'blur(20px) saturate(140%)',
          }}
        >
          <DialogHeader className="pb-2">
            <DialogTitle className="flex items-center gap-2 text-white">
              <UserPlus className="w-5 h-5 text-primary" />
              {t('addNewUser')}
            </DialogTitle>
            <DialogDescription className="text-white/55">
              {t('addNewUserDescription')}
            </DialogDescription>
          </DialogHeader>
          {/* 2.5.1+: `px-0.5` gives the inputs' `ring-1` enough
              horizontal room to actually render on the left/right
              edges. Without it, `overflow-y-auto` here implicitly
              clips `overflow-x`, which chops the box-shadow that
              implements the ring — leaving only the top/bottom of
              the rounded outline visible. The 2px of padding is
              imperceptible but lets the ring complete its loop. */}
          <div className="flex-1 overflow-y-auto space-y-3 py-1 px-0.5">
            {error && (
              <div className="p-2.5 bg-destructive/15 ring-1 ring-destructive/30 rounded-md flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />
                <span className="text-sm text-destructive">{error}</span>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="newEmail" className="text-xs text-white/80">{t('emailRequired')}</Label>
              <Input
                id="newEmail"
                type="email"
                placeholder={t('emailPlaceholder')}
                value={newUserData.email}
                onChange={(e) => setNewUserData(prev => ({ ...prev, email: e.target.value }))}
                className="h-9 bg-white/[0.04] border-0 ring-1 ring-white/10 text-white placeholder:text-white/40 focus-visible:ring-primary/40"
                autoComplete="off"
                data-form-type="other"
                data-lpignore="true"
                data-1p-ignore
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="newUsername" className="text-xs text-white/80">{t('username')}</Label>
                <Input
                  id="newUsername"
                  placeholder={t('usernamePlaceholder')}
                  value={newUserData.username}
                  onChange={(e) => setNewUserData(prev => ({ ...prev, username: e.target.value }))}
                  className="h-9 bg-white/[0.04] border-0 ring-1 ring-white/10 text-white placeholder:text-white/40 focus-visible:ring-primary/40"
                  autoComplete="off"
                  data-form-type="other"
                  data-lpignore="true"
                  data-1p-ignore
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="newName" className="text-xs text-white/80">{t('displayName')}</Label>
                <Input
                  id="newName"
                  placeholder={t('displayNamePlaceholder')}
                  value={newUserData.name}
                  onChange={(e) => setNewUserData(prev => ({ ...prev, name: e.target.value }))}
                  className="h-9 bg-white/[0.04] border-0 ring-1 ring-white/10 text-white placeholder:text-white/40 focus-visible:ring-primary/40"
                  autoComplete="off"
                  data-form-type="other"
                  data-lpignore="true"
                  data-1p-ignore
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="newPassword" className="text-xs text-white/80">{t('passwordRequired')}</Label>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => generateRandomPassword(true)}
                    className="h-7 px-2 text-xs text-white/85 hover:text-white hover:bg-white/[0.08]"
                  >
                    <RefreshCw className="w-3 h-3 mr-1" />
                    {tc('generate')}
                  </Button>
                  {newUserData.password && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => copyPassword(newUserData.password)}
                      className="h-7 px-2 text-xs text-white/85 hover:text-white hover:bg-white/[0.08]"
                    >
                      {copiedPassword ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    </Button>
                  )}
                </div>
              </div>
              <div className="relative">
                <Input
                  id="newPassword"
                  type={showPassword ? 'text' : 'password'}
                  value={newUserData.password}
                  onChange={(e) => setNewUserData(prev => ({ ...prev, password: e.target.value }))}
                  className="pr-9 h-9 bg-white/[0.04] border-0 ring-1 ring-white/10 text-white placeholder:text-white/40 focus-visible:ring-primary/40"
                  autoComplete="new-password"
                  data-form-type="other"
                  data-lpignore="true"
                  data-1p-ignore
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-white/55 hover:text-white"
                  title={showPassword ? t('hidePassword') : t('showPassword')}
                >
                  {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="newConfirmPassword" className="text-xs text-white/80">{t('confirmPasswordRequired')}</Label>
              <div className="relative">
                <Input
                  id="newConfirmPassword"
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={newUserData.confirmPassword}
                  onChange={(e) => setNewUserData(prev => ({ ...prev, confirmPassword: e.target.value }))}
                  className="pr-9 h-9 bg-white/[0.04] border-0 ring-1 ring-white/10 text-white placeholder:text-white/40 focus-visible:ring-primary/40"
                  autoComplete="new-password"
                  data-form-type="other"
                  data-lpignore="true"
                  data-1p-ignore
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-white/55 hover:text-white"
                  title={showConfirmPassword ? t('hidePassword') : t('showPassword')}
                >
                  {showConfirmPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
            <PasswordRequirements password={newUserData.password} />
          </div>
          <DialogFooter className="pt-3 gap-2">
            <DialogClose asChild>
              <Button
                variant="ghost"
                size="sm"
                className="bg-white/[0.06] hover:bg-white/[0.12] ring-1 ring-white/15 text-white border-0"
              >
                {tc('cancel')}
              </Button>
            </DialogClose>
            <Button
              size="sm"
              onClick={handleAddUser}
              disabled={saving}
              style={{ color: '#ffffff' }}
              className="font-semibold"
            >
              {saving ? tc('creating') : t('addUser')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit User Modal */}
      <Dialog open={showEditUserModal} onOpenChange={setShowEditUserModal}>
        <DialogContent className="sm:max-w-md max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Edit className="w-5 h-5 text-primary" />
              {t('editUserTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('editUserDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-4 py-4">
            {error && (
              <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />
                <span className="text-sm text-destructive">{error}</span>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="editEmail">{t('emailRequired')}</Label>
              <Input
                id="editEmail"
                type="email"
                value={editFormData.email}
                onChange={(e) => setEditFormData(prev => ({ ...prev, email: e.target.value }))}
                autoComplete="off"
                data-form-type="other"
                data-lpignore="true"
                data-1p-ignore
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="editUsername">{t('username')}</Label>
              <Input
                id="editUsername"
                value={editFormData.username}
                onChange={(e) => setEditFormData(prev => ({ ...prev, username: e.target.value }))}
                autoComplete="off"
                data-form-type="other"
                data-lpignore="true"
                data-1p-ignore
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="editName">{t('displayName')}</Label>
              <Input
                id="editName"
                value={editFormData.name}
                onChange={(e) => setEditFormData(prev => ({ ...prev, name: e.target.value }))}
                autoComplete="off"
                data-form-type="other"
                data-lpignore="true"
                data-1p-ignore
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{tc('cancel')}</Button>
            </DialogClose>
            <Button onClick={handleEditUser} disabled={saving}>
              {saving ? tc('saving') : tc('saveChanges')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change Password Modal */}
      <Dialog open={showPasswordModal} onOpenChange={setShowPasswordModal}>
        <DialogContent className="sm:max-w-md max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="w-5 h-5 text-primary" />
              {t('changePasswordTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('changePasswordDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-4 py-4">
            {error && (
              <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />
                <span className="text-sm text-destructive">{error}</span>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="oldPassword">{t('currentPasswordStar')}</Label>
              <Input
                id="oldPassword"
                type="password"
                value={passwordData.oldPassword}
                onChange={(e) => setPasswordData(prev => ({ ...prev, oldPassword: e.target.value }))}
                autoComplete="current-password"
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">{t('newPasswordStar')}</Label>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => generateRandomPassword(false)}
                    className="h-7 px-2 text-xs"
                  >
                    <RefreshCw className="w-3 h-3 mr-1" />
                    {tc('generate')}
                  </Button>
                  {passwordData.password && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => copyPassword(passwordData.password)}
                      className="h-7 px-2 text-xs"
                    >
                      {copiedPassword ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    </Button>
                  )}
                </div>
              </div>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={passwordData.password}
                  onChange={(e) => setPasswordData(prev => ({ ...prev, password: e.target.value }))}
                  className="pr-10"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">{t('confirmPasswordRequired')}</Label>
              <div className="relative">
                <Input
                  id="confirmPassword"
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={passwordData.confirmPassword}
                  onChange={(e) => setPasswordData(prev => ({ ...prev, confirmPassword: e.target.value }))}
                  className="pr-10"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <PasswordRequirements password={passwordData.password} />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{tc('cancel')}</Button>
            </DialogClose>
            <Button onClick={handleChangePassword} disabled={saving}>
              {saving ? t('changing') : t('changePasswordTitle')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Passkeys Modal */}
      <Dialog open={showPasskeyModal} onOpenChange={setShowPasskeyModal}>
        <DialogContent className="sm:max-w-md max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Fingerprint className="w-5 h-5 text-primary" />
              {t('passkeysTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('passkeysDescription', { name: editingUser?.name || editingUser?.email || '' })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-4 py-4">
            {error && (
              <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />
                <span className="text-sm text-destructive">{error}</span>
              </div>
            )}

            {passkeys.length === 0 ? (
              <div className="text-center py-6 text-muted-foreground">
                <Fingerprint className="w-10 h-10 mx-auto mb-3 opacity-50" />
                <p className="text-sm">{t('noPasskeys')}</p>
                <p className="text-xs mt-1">{t('noPasskeysHint')}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {passkeys.map((passkey) => (
                  <div
                    key={passkey.id}
                    className="flex items-center justify-between p-3 rounded-lg border border-border"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Fingerprint className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
                          {passkey.deviceType || t('unknownDevice')}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t('added', { date: formatDate(passkey.createdAt) })}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeletePasskey(passkey.id)}
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {loggedInUser?.id === editingUser?.id && (
              <Button
                onClick={handleRegisterPasskey}
                disabled={saving}
                className="w-full"
              >
                <Plus className="w-4 h-4 mr-2" />
                {saving ? t('registering') : t('addNewPasskey')}
              </Button>
            )}

            {loggedInUser?.id !== editingUser?.id && (
              <p className="text-xs text-muted-foreground text-center">
                {t('passkeysOwnAccountOnly')}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{tc('close')}</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Modal — 3.2.x glass refresh. Same recipe
          as the Add User modal above (transparent backdrop, frosted
          glass shell, white text hierarchy) so the two dialogs read as
          one family instead of the old flat dark popup. */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent
          overlayClassName="bg-transparent"
          className="sm:max-w-md bg-white/[0.06] text-white ring-1 ring-white/10 border-0 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.7)]"
          style={{
            backdropFilter: 'blur(20px) saturate(140%)',
            WebkitBackdropFilter: 'blur(20px) saturate(140%)',
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-white">
              <Trash2 className="w-5 h-5 text-destructive" />
              {t('confirmDeleteTitle')}
            </DialogTitle>
            <DialogDescription className="text-white/55">
              {t('confirmDeleteUser', { name: deleteTarget?.name || deleteTarget?.email || '' })}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <div className="p-3 bg-destructive/10 ring-1 ring-destructive/25 rounded-md flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />
              <span className="text-sm text-destructive">{error}</span>
            </div>
          )}
          <DialogFooter className="pt-3 gap-2">
            <DialogClose asChild>
              <Button
                variant="ghost"
                size="sm"
                className="bg-white/[0.06] hover:bg-white/[0.12] ring-1 ring-white/15 text-white border-0"
              >
                {tc('cancel')}
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={saving}
              className="font-semibold"
            >
              {saving ? tc('deleting') : t('deleteUserButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
