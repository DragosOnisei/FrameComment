'use client'

import { useCallback, useEffect, useState } from 'react'
import { HardDrive, Server, Cloud, Database, Loader2, Check, X, Save, ArrowLeftRight, StopCircle, Trash2, Info } from 'lucide-react'
import { CollapsibleSection } from '@/components/ui/collapsible-section'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { apiJson, apiPost } from '@/lib/api-client'

type Backend = 'local' | 'fc' | 'r2' | 'aws'

interface StorageSectionProps {
  show: boolean
  setShow: (value: boolean) => void
  collapsible?: boolean
}

interface StorageConfig {
  activeStorageBackend: Backend | null
  effectiveBackend: Backend
  localStoragePath: string
  defaultLocalStoragePath: string
  r2: { endpoint: string; region: string; bucket: string; accessKeyId: string; hasSecret: boolean }
  aws: { region: string; bucket: string; accessKeyId: string; hasSecret: boolean }
}

const OPTIONS: Array<{ id: Backend; title: string; blurb: string; icon: typeof HardDrive; billed: string }> = [
  {
    id: 'local',
    title: 'Local Storage',
    blurb: "Files stay on this server's own disk. No per-GB storage charge.",
    icon: HardDrive,
    billed: 'Billed per user only',
  },
  {
    id: 'fc',
    title: 'FrameComment Server (Default)',
    blurb: 'Managed cloud storage hosted by FrameComment. Nothing to configure.',
    icon: Server,
    billed: 'Billed per user + per GB stored',
  },
  {
    id: 'r2',
    title: 'Cloudflare R2',
    blurb: 'Your own Cloudflare R2 bucket. Enter the credentials below.',
    icon: Cloud,
    billed: 'Billed per user only',
  },
  {
    id: 'aws',
    title: 'AWS S3',
    blurb: 'Your own Amazon S3 bucket. Enter the credentials below.',
    icon: Database,
    billed: 'Billed per user only',
  },
]

interface BackendStatus {
  backend: Backend
  label: string
  isActive: boolean
  fileCount: number
  bytes: number
  mountPath: string
  fullyMirroredOnActive: boolean
}

function formatBytes(b: number): string {
  if (!b || b <= 0) return '0 B'
  if (b < 1024) return `${b} B`
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`
  if (b < 1024 ** 4) return `${(b / 1024 ** 3).toFixed(2)} GB`
  return `${(b / 1024 ** 4).toFixed(2)} TB`
}

interface TransferStatus {
  status: 'idle' | 'running' | 'completed' | 'cancelled' | 'error'
  mode: 'transfer' | 'purge'
  targetLabel: string
  activeBackend?: Backend
  activeBackendLabel: string
  purgeBackend: Backend | null
  total: number
  processed: number
  copiedFiles: number
  deletedFiles: number
  failed: number
  currentLabel: string
  error: string | null
  recentErrors: string[]
  backends?: BackendStatus[]
}

const SECRET_MASK = '••••••••••••'

export function StorageSection({ show, setShow, collapsible = true }: StorageSectionProps) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedNote, setSavedNote] = useState<string | null>(null)

  const [selected, setSelected] = useState<Backend>('local')
  // Local uploads folder (Phase 2d)
  const [localStoragePath, setLocalStoragePath] = useState('')
  const [defaultLocalStoragePath, setDefaultLocalStoragePath] = useState('')
  // R2 form
  const [r2Endpoint, setR2Endpoint] = useState('')
  const [r2Region, setR2Region] = useState('auto')
  const [r2Bucket, setR2Bucket] = useState('')
  const [r2AccessKeyId, setR2AccessKeyId] = useState('')
  const [r2Secret, setR2Secret] = useState('')
  const [r2HasSecret, setR2HasSecret] = useState(false)
  // AWS form
  const [awsRegion, setAwsRegion] = useState('us-east-1')
  const [awsBucket, setAwsBucket] = useState('')
  const [awsAccessKeyId, setAwsAccessKeyId] = useState('')
  const [awsSecret, setAwsSecret] = useState('')
  const [awsHasSecret, setAwsHasSecret] = useState(false)
  // Test connection state, keyed by backend
  const [testing, setTesting] = useState<Backend | null>(null)
  const [testResult, setTestResult] = useState<{ backend: Backend; ok: boolean; message: string } | null>(null)
  // Transfer (Phase 2) state
  const [transfer, setTransfer] = useState<TransferStatus | null>(null)
  const [transferError, setTransferError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [purging, setPurging] = useState<Backend | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const cfg = await apiJson<StorageConfig>('/api/settings/storage')
      setSelected(cfg.activeStorageBackend ?? cfg.effectiveBackend)
      setLocalStoragePath(cfg.localStoragePath || '')
      setDefaultLocalStoragePath(cfg.defaultLocalStoragePath || '')
      setR2Endpoint(cfg.r2.endpoint)
      setR2Region(cfg.r2.region || 'auto')
      setR2Bucket(cfg.r2.bucket)
      setR2AccessKeyId(cfg.r2.accessKeyId)
      setR2HasSecret(cfg.r2.hasSecret)
      setR2Secret(cfg.r2.hasSecret ? SECRET_MASK : '')
      setAwsRegion(cfg.aws.region || 'us-east-1')
      setAwsBucket(cfg.aws.bucket)
      setAwsAccessKeyId(cfg.aws.accessKeyId)
      setAwsHasSecret(cfg.aws.hasSecret)
      setAwsSecret(cfg.aws.hasSecret ? SECRET_MASK : '')
    } catch (e: any) {
      setError(e?.message || 'Failed to load storage settings')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const fetchTransfer = useCallback(async () => {
    try {
      const s = await apiJson<TransferStatus>('/api/settings/storage/transfer')
      setTransfer(s)
      return s
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    void fetchTransfer()
  }, [fetchTransfer])

  // Poll while a transfer is running.
  useEffect(() => {
    if (transfer?.status !== 'running') return
    const id = setInterval(() => { void fetchTransfer() }, 2000)
    return () => clearInterval(id)
  }, [transfer?.status, fetchTransfer])

  const handleStartTransfer = useCallback(async () => {
    setStarting(true)
    setTransferError(null)
    try {
      await apiPost('/api/settings/storage/transfer', { action: 'start' })
      await fetchTransfer()
    } catch (e: any) {
      setTransferError(e?.message || 'Failed to start transfer')
    } finally {
      setStarting(false)
    }
  }, [fetchTransfer])

  const handleCancelTransfer = useCallback(async () => {
    try {
      await apiPost('/api/settings/storage/transfer', { action: 'cancel' })
      await fetchTransfer()
    } catch {
      /* ignore */
    }
  }, [fetchTransfer])

  const handlePurge = useCallback(async (backend: Backend, label: string, fileCount: number) => {
    const activeLabel = transfer?.activeBackendLabel || 'the active backend'
    const message =
      `⚠ WARNING — PERMANENT DELETION\n\n` +
      `This will permanently delete all ${fileCount} item(s) stored on ${label} — ` +
      `every video original, preview, HLS segment, thumbnail, attachment and document that lives there.\n\n` +
      `These files stay available on ${activeLabel} (the active backend): each file is re-verified to exist there ` +
      `before anything is removed, and nothing that isn't already copied will be deleted.\n\n` +
      `This cannot be undone. Continue?`
    if (!window.confirm(message)) return
    setPurging(backend)
    setTransferError(null)
    try {
      await apiPost('/api/settings/storage/transfer', { action: 'purge', backend })
      await fetchTransfer()
    } catch (e: any) {
      setTransferError(e?.message || 'Failed to start deletion')
    } finally {
      setPurging(null)
    }
  }, [fetchTransfer, transfer?.activeBackendLabel])

  // The secret payload sent to the server: blank when it's still the mask
  // (meaning "leave unchanged"), otherwise the freshly typed value.
  const r2SecretPayload = r2Secret && r2Secret !== SECRET_MASK ? r2Secret : ''
  const awsSecretPayload = awsSecret && awsSecret !== SECRET_MASK ? awsSecret : ''

  const buildBody = () => ({
    activeStorageBackend: selected,
    localStoragePath: localStoragePath.trim(),
    r2: {
      endpoint: r2Endpoint,
      region: r2Region,
      bucket: r2Bucket,
      accessKeyId: r2AccessKeyId,
      secretAccessKey: r2SecretPayload,
    },
    aws: {
      region: awsRegion,
      bucket: awsBucket,
      accessKeyId: awsAccessKeyId,
      secretAccessKey: awsSecretPayload,
    },
  })

  const handleTest = useCallback(async (backend: 'r2' | 'aws') => {
    setTesting(backend)
    setTestResult(null)
    try {
      const res = await apiPost<{ ok: boolean; error?: string }>('/api/settings/storage', {
        action: 'test',
        backend,
        ...buildBody(),
      })
      setTestResult({
        backend,
        ok: !!res.ok,
        message: res.ok ? 'Connection successful' : (res.error || 'Connection failed'),
      })
    } catch (e: any) {
      setTestResult({ backend, ok: false, message: e?.message || 'Connection failed' })
    } finally {
      setTesting(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, r2Endpoint, r2Region, r2Bucket, r2AccessKeyId, r2Secret, awsRegion, awsBucket, awsAccessKeyId, awsSecret])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    setSavedNote(null)
    try {
      await apiPost('/api/settings/storage', buildBody())
      setSavedNote('Storage settings saved. New uploads will use ' +
        (OPTIONS.find((o) => o.id === selected)?.title || selected) + '.')
      // Refresh masks / hasSecret flags from the server.
      await load()
    } catch (e: any) {
      setError(e?.message || 'Failed to save storage settings')
    } finally {
      setSaving(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, r2Endpoint, r2Region, r2Bucket, r2AccessKeyId, r2Secret, awsRegion, awsBucket, awsAccessKeyId, awsSecret, load])

  const inputCls = 'bg-white/[0.04] border-white/10 text-white placeholder:text-white/30'

  return (
    <CollapsibleSection
      className="border-0 bg-white/[0.04] ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] text-white"
      style={{
        backdropFilter: 'blur(20px) saturate(140%)',
        WebkitBackdropFilter: 'blur(20px) saturate(140%)',
      }}
      title="Storage"
      description="Choose where new uploads are stored. Existing files keep playing from wherever they already live."
      open={show}
      onOpenChange={setShow}
      contentClassName="space-y-4 border-t border-white/10 pt-4"
      collapsible={collapsible}
    >
      {loading ? (
        <div className="flex items-center gap-2 text-white/60 text-sm py-6">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading storage settings…
        </div>
      ) : (
        <>
          {error && (
            <div className="rounded-lg bg-red-500/10 ring-1 ring-red-500/30 text-red-200 text-sm px-3 py-2">
              {error}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            {OPTIONS.map((opt) => {
              const Icon = opt.icon
              const active = selected === opt.id
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => { setSelected(opt.id); setTestResult(null) }}
                  className={
                    'text-left p-4 rounded-xl ring-1 transition-colors ' +
                    (active
                      ? 'bg-white/[0.10] ring-white/40'
                      : 'bg-white/[0.03] ring-white/10 hover:bg-white/[0.06]')
                  }
                >
                  <div className="flex items-center gap-2">
                    <span className={'flex h-9 w-9 items-center justify-center rounded-lg ' + (active ? 'bg-white/15' : 'bg-white/[0.06]')}>
                      <Icon className="w-4.5 h-4.5" />
                    </span>
                    <span className="font-medium">{opt.title}</span>
                    {active && <Check className="w-4 h-4 ml-auto text-emerald-300" />}
                  </div>
                  <p className="text-xs text-white/55 mt-2">{opt.blurb}</p>
                  <p className="text-[11px] text-white/40 mt-1.5">{opt.billed}</p>
                </button>
              )
            })}
          </div>

          {/* Local Storage — uploads folder */}
          {selected === 'local' && (
            <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
              <p className="text-sm font-medium">Uploads folder</p>
              <p className="text-xs text-white/55">
                Where uploads are stored on this server&apos;s disk — a dataset path on a TrueNAS/Linux
                server, or a folder on your Mac/Windows drive. The app must have write access to it.
                Applies to new uploads; files already stored stay where they are and keep playing.
              </p>
              <div className="space-y-2">
                <Label htmlFor="localStoragePath">Folder path</Label>
                <Input
                  id="localStoragePath"
                  className={inputCls}
                  placeholder={defaultLocalStoragePath || '/mnt/tank/framecomment/uploads'}
                  value={localStoragePath}
                  onChange={(e) => setLocalStoragePath(e.target.value)}
                />
                <p className="text-[11px] text-white/40">
                  Leave empty to use the server default{defaultLocalStoragePath ? ` (${defaultLocalStoragePath})` : ''}.
                  It&apos;s validated as writable when you save.
                </p>
              </div>
            </div>
          )}

          {/* R2 credentials */}
          {selected === 'r2' && (
            <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
              <p className="text-sm font-medium">Cloudflare R2 credentials</p>
              <div className="space-y-2">
                <Label htmlFor="r2Endpoint">S3 API endpoint</Label>
                <Input id="r2Endpoint" className={inputCls} placeholder="https://<account>.r2.cloudflarestorage.com"
                  value={r2Endpoint} onChange={(e) => setR2Endpoint(e.target.value)} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="r2Bucket">Bucket</Label>
                  <Input id="r2Bucket" className={inputCls} placeholder="my-bucket" value={r2Bucket} onChange={(e) => setR2Bucket(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="r2Region">Region</Label>
                  <Input id="r2Region" className={inputCls} placeholder="auto" value={r2Region} onChange={(e) => setR2Region(e.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="r2AccessKeyId">Access key ID</Label>
                <Input id="r2AccessKeyId" className={inputCls} autoComplete="off" value={r2AccessKeyId} onChange={(e) => setR2AccessKeyId(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="r2Secret">Secret access key</Label>
                <Input id="r2Secret" type="password" className={inputCls} autoComplete="off"
                  placeholder={r2HasSecret ? 'Leave to keep current key' : ''}
                  value={r2Secret} onFocus={() => { if (r2Secret === SECRET_MASK) setR2Secret('') }} onChange={(e) => setR2Secret(e.target.value)} />
                <p className="text-[11px] text-white/40">Stored encrypted at rest.</p>
              </div>
              <TestRow backend="r2" testing={testing} testResult={testResult} onTest={handleTest} />
            </div>
          )}

          {/* AWS credentials */}
          {selected === 'aws' && (
            <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
              <p className="text-sm font-medium">AWS S3 credentials</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="awsBucket">Bucket</Label>
                  <Input id="awsBucket" className={inputCls} placeholder="my-bucket" value={awsBucket} onChange={(e) => setAwsBucket(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="awsRegion">Region</Label>
                  <Input id="awsRegion" className={inputCls} placeholder="us-east-1" value={awsRegion} onChange={(e) => setAwsRegion(e.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="awsAccessKeyId">Access key ID</Label>
                <Input id="awsAccessKeyId" className={inputCls} autoComplete="off" value={awsAccessKeyId} onChange={(e) => setAwsAccessKeyId(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="awsSecret">Secret access key</Label>
                <Input id="awsSecret" type="password" className={inputCls} autoComplete="off"
                  placeholder={awsHasSecret ? 'Leave to keep current key' : ''}
                  value={awsSecret} onFocus={() => { if (awsSecret === SECRET_MASK) setAwsSecret('') }} onChange={(e) => setAwsSecret(e.target.value)} />
                <p className="text-[11px] text-white/40">Stored encrypted at rest.</p>
              </div>
              <TestRow backend="aws" testing={testing} testResult={testResult} onTest={handleTest} />
            </div>
          )}

          {savedNote && (
            <div className="rounded-lg bg-emerald-500/10 ring-1 ring-emerald-500/30 text-emerald-200 text-sm px-3 py-2">
              {savedNote}
            </div>
          )}

          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Save storage settings
            </Button>
          </div>

          {/* ── Transfer & clean up storage (Phase 2 / 2c) ────────────────── */}
          <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10 mt-2">
            <div className="flex items-center gap-2">
              <ArrowLeftRight className="w-4 h-4" />
              <p className="text-sm font-medium">Transfer &amp; clean up storage</p>
            </div>
            <p className="text-xs text-white/55">
              &ldquo;Transfer&rdquo; copies every file that isn&apos;t already on the active backend
              {transfer?.activeBackendLabel ? ` (${transfer.activeBackendLabel})` : ''} over to it, keeping the
              originals (each file then shows both location tags). Once a backend is fully mirrored on the active
              one, a &ldquo;Delete all files&hellip;&rdquo; button appears under it — it re-verifies every file
              exists on the active backend before removing anything. Save your backend choice first.
            </p>

            {transferError && (
              <div className="rounded-lg bg-red-500/10 ring-1 ring-red-500/30 text-red-200 text-sm px-3 py-2">
                {transferError}
              </div>
            )}

            {transfer?.status === 'running' ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-white/60">
                  <span>
                    {transfer.mode === 'purge'
                      ? `Deleting from ${storageBackendLabelSafe(transfer.purgeBackend)} — ${transfer.currentLabel || 'verifying…'}`
                      : (transfer.currentLabel || 'Preparing…')}
                  </span>
                  <span>{transfer.processed}/{transfer.total}</span>
                </div>
                <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
                  <div
                    className={'h-full transition-all ' + (transfer.mode === 'purge' ? 'bg-red-400/80' : 'bg-emerald-400/80')}
                    style={{ width: `${transfer.total > 0 ? Math.round((transfer.processed / transfer.total) * 100) : 0}%` }}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-white/50">
                    {transfer.mode === 'purge'
                      ? `${transfer.deletedFiles} files deleted`
                      : `${transfer.copiedFiles} files copied`}
                    {transfer.failed > 0 ? ` · ${transfer.failed} skipped` : ''}
                  </span>
                  <Button type="button" variant="outline" size="sm" onClick={handleCancelTransfer}>
                    <StopCircle className="w-4 h-4 mr-2" /> Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3 flex-wrap">
                <Button type="button" variant="outline" onClick={handleStartTransfer} disabled={starting}>
                  {starting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ArrowLeftRight className="w-4 h-4 mr-2" />}
                  Transfer files now
                </Button>
                {transfer && transfer.status !== 'idle' && (
                  <span className={'text-sm ' + (transfer.status === 'error' ? 'text-red-300' : transfer.status === 'cancelled' ? 'text-amber-300' : 'text-emerald-300')}>
                    {transfer.status === 'completed' && (transfer.mode === 'purge'
                      ? `Deleted ${transfer.deletedFiles} files${transfer.failed > 0 ? `, ${transfer.failed} skipped` : ''}`
                      : `Done — ${transfer.copiedFiles} files copied${transfer.failed > 0 ? `, ${transfer.failed} skipped` : ''}`)}
                    {transfer.status === 'cancelled' && `Cancelled — ${transfer.processed}/${transfer.total} done`}
                    {transfer.status === 'error' && `Error: ${transfer.error || 'job failed'}`}
                  </span>
                )}
              </div>
            )}

            {/* Per-backend storage locations + delete buttons */}
            {transfer?.backends && transfer.backends.length > 0 && (
              <div className="space-y-2 pt-1">
                <p className="text-xs font-medium text-white/70">Storage locations</p>
                {transfer.backends.map((b) => (
                  <div key={b.backend} className="rounded-lg bg-white/[0.03] ring-1 ring-white/10 px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm text-white">
                          {b.label}
                          {b.isActive && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30">Active</span>}
                        </p>
                        <p className="text-[11px] text-white/45 mt-0.5">
                          {b.fileCount} item{b.fileCount === 1 ? '' : 's'} · {formatBytes(b.bytes)}
                        </p>
                        {b.mountPath && (
                          <p className="text-[11px] text-white/40 mt-0.5 truncate font-mono" title={b.mountPath}>
                            {b.mountPath}
                          </p>
                        )}
                      </div>
                      {!b.isActive && b.fileCount > 0 && (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={!b.fullyMirroredOnActive || transfer.status === 'running' || purging === b.backend}
                            className={
                              b.fullyMirroredOnActive
                                ? 'text-red-300 hover:text-red-200 border-red-500/30 hover:bg-red-500/10'
                                : 'text-white/40 border-white/10 opacity-60 cursor-not-allowed'
                            }
                            onClick={() => b.fullyMirroredOnActive && handlePurge(b.backend, b.label, b.fileCount)}
                          >
                            {purging === b.backend ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Trash2 className="w-4 h-4 mr-2" />}
                            Delete all files from this storage
                          </Button>
                          {!b.fullyMirroredOnActive && (
                            <span
                              className="text-white/40 hover:text-white/70 cursor-help"
                              title={`Available only after everything here is also on ${transfer.activeBackendLabel} — the item count and size must match exactly. Run Transfer first.`}
                            >
                              <Info className="w-4 h-4" />
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    {/* Clear WARNING + explanation of exactly what deletion removes. */}
                    {!b.isActive && b.fileCount > 0 && b.fullyMirroredOnActive && (
                      <p className="text-[11px] text-red-300/80 mt-2 flex items-start gap-1.5">
                        <span className="font-semibold shrink-0">⚠ WARNING:</span>
                        <span>
                          permanently deletes all {b.fileCount} item(s) from {b.label} (originals, previews,
                          HLS, thumbnails, attachments, documents). They stay on {transfer.activeBackendLabel};
                          each file is re-verified there first. This cannot be undone.
                        </span>
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {transfer && transfer.recentErrors && transfer.recentErrors.length > 0 && (
              <details className="text-xs text-white/50">
                <summary className="cursor-pointer">{transfer.recentErrors.length} recent note(s)</summary>
                <ul className="mt-1 space-y-0.5 list-disc pl-4">
                  {transfer.recentErrors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </details>
            )}
          </div>
        </>
      )}
    </CollapsibleSection>
  )
}

/** Small local label helper for the purge progress line (client-safe). */
function storageBackendLabelSafe(b: string | null | undefined): string {
  switch (b) {
    case 'local': return 'Local storage'
    case 'fc': return 'FrameComment Server'
    case 'r2': return 'Cloudflare R2'
    case 'aws': return 'AWS storage'
    default: return 'storage'
  }
}

function TestRow({
  backend,
  testing,
  testResult,
  onTest,
}: {
  backend: 'r2' | 'aws'
  testing: Backend | null
  testResult: { backend: Backend; ok: boolean; message: string } | null
  onTest: (b: 'r2' | 'aws') => void
}) {
  const result = testResult && testResult.backend === backend ? testResult : null
  return (
    <div className="flex items-center gap-3 pt-1">
      <Button type="button" variant="outline" size="sm" disabled={testing === backend} onClick={() => onTest(backend)}>
        {testing === backend ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
        Test connection
      </Button>
      {result && (
        <span className={'inline-flex items-center gap-1 text-sm ' + (result.ok ? 'text-emerald-300' : 'text-red-300')}>
          {result.ok ? <Check className="w-4 h-4" /> : <X className="w-4 h-4" />}
          {result.message}
        </span>
      )}
    </div>
  )
}
