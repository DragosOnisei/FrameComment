'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Youtube,
  Users,
  Folder,
  Plus,
  X,
  ArrowLeft,
  Sparkles,
} from 'lucide-react'
import { apiFetch } from '@/lib/api-client'

/**
 * 2.4.2+ TemplateModal — wizard for creating multi-level folder
 * scaffolds from a named template. Two screens:
 *
 *   Screen 1 (picker): split-pane. Left lists the two templates,
 *   right shows a tree preview + short explanation of what'll be
 *   created. Sitting on a template card highlights it and updates
 *   the right pane; clicking "Use this template" advances.
 *
 *   Screen 2 (form): collects the user inputs for the chosen
 *   template (project picker + template-specific fields).
 *   "← Back" returns to the picker; "Create folders" POSTs to
 *   /api/folders/from-template and on success deep-links the
 *   user into the freshly-created top-level folder so they can
 *   immediately start uploading.
 *
 * State is reset every time the modal opens — there's no benefit
 * to remembering a half-finished wizard between sessions.
 */

type TemplateId = 'youtube' | 'ugc'

type ProjectOption = { id: string; title: string }

interface TemplateModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: ProjectOption[]
  defaultProjectId?: string | null
}

const TEMPLATE_META: Record<
  TemplateId,
  {
    title: string
    blurb: string
    icon: typeof Youtube
    accent: string
    sample: { day?: string; episode?: string; campaign?: string; actors?: string[] }
  }
> = {
  youtube: {
    title: 'YouTube',
    blurb:
      'Per-episode review structure. One folder for the shoot day, one for the episode, three review buckets inside.',
    icon: Youtube,
    accent: 'text-red-500',
    sample: { day: 'Day7', episode: 'Episode 12 — First Date' },
  },
  ugc: {
    title: 'UGC',
    blurb:
      'Per-campaign actor split. One folder per actor under the campaign, each with vertical (9:16) and portrait (4:5) crop buckets.',
    icon: Users,
    accent: 'text-blue-500',
    sample: { campaign: 'Spring 2026 Push', actors: ['Maria', 'Ion'] },
  },
}

export function TemplateModal({
  open,
  onOpenChange,
  projects,
  defaultProjectId,
}: TemplateModalProps) {
  const router = useRouter()

  // Two-screen wizard state. Reset whenever the modal opens.
  // 2.5.0+: dropped the mouseEnter-driven `hovered` preview — the
  // preview pane now only reflects what the user has *clicked*,
  // so brushing past the other template doesn't surprise-swap the
  // tree. Default preview is YouTube until the user picks one.
  const [screen, setScreen] = useState<'pick' | 'form'>('pick')
  const [chosen, setChosen] = useState<TemplateId | null>(null)

  // Form state (shared bag — only the fields relevant to the
  // chosen template are read at submit time).
  const [projectId, setProjectId] = useState<string>('')
  const [day, setDay] = useState('')
  const [episode, setEpisode] = useState('')
  const [campaign, setCampaign] = useState('')
  const [actors, setActors] = useState<string[]>([''])
  const [submitting, setSubmitting] = useState(false)

  // Reset on every fresh open. Using a separate effect rather
  // than a key on the dialog because we want the close animation
  // to play with the final state visible.
  useEffect(() => {
    if (!open) return
    setScreen('pick')
    setChosen(null)
    setProjectId(defaultProjectId || '')
    setDay('')
    setEpisode('')
    setCampaign('')
    setActors([''])
    setSubmitting(false)
  }, [open, defaultProjectId])

  // 2.5.0+: preview tracks only the *clicked* template. Until the
  // user picks one the preview falls back to YouTube so the right
  // pane is never blank on first open.
  const previewTemplate: TemplateId = chosen ?? 'youtube'

  const canSubmit = useMemo(() => {
    if (!projectId) return false
    if (chosen === 'youtube') return day.trim().length > 0 && episode.trim().length > 0
    if (chosen === 'ugc') {
      const cleaned = actors.map((a) => a.trim()).filter(Boolean)
      return campaign.trim().length > 0 && cleaned.length > 0
    }
    return false
  }, [chosen, projectId, day, episode, campaign, actors])

  const addActor = () => setActors((prev) => [...prev, ''])
  const removeActor = (i: number) =>
    setActors((prev) => (prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i)))
  const updateActor = (i: number, value: string) =>
    setActors((prev) => prev.map((a, idx) => (idx === i ? value : a)))

  const handleSubmit = async () => {
    if (!chosen || !canSubmit || submitting) return
    setSubmitting(true)

    const payload =
      chosen === 'youtube'
        ? {
            template: 'youtube' as const,
            projectId,
            params: { day: day.trim(), episode: episode.trim() },
          }
        : {
            template: 'ugc' as const,
            projectId,
            params: {
              campaign: campaign.trim(),
              actors: actors.map((a) => a.trim()).filter(Boolean),
            },
          }

    try {
      const res = await apiFetch('/api/folders/from-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        alert(data?.error || 'Failed to create folders')
        setSubmitting(false)
        return
      }
      const data = await res.json()
      onOpenChange(false)
      // Deep-link into the top-level folder so the user can see
      // the structure and start uploading immediately. The auto-
      // rename feedback ("Day7 was taken, used Day7 (1)") is
      // visible in the URL bar and breadcrumb — the user lands
      // inside the renamed folder so the rename is self-evident.
      if (data.rootFolder?.id) {
        router.push(`/admin/projects/${projectId}/folder/${data.rootFolder.id}`)
      } else {
        router.refresh()
      }
    } catch (err) {
      alert('Failed to create folders')
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 2.5.0+: frosted-glass shell that matches the projects-list
          table panel — `#13181d` at ~65% with a heavy backdrop blur
          and a hairline white-10 ring. Default `bg-background` /
          border styles from the Dialog primitive are overridden so
          the modal sits in the same design family as the rest of
          the admin chrome. */}
      <DialogContent
        hideClose
        overlayClassName="bg-transparent"
        // 2.5.1+: trimmed further (xl → md, ~448px) — with the
        // picker reduced to plain text on the left and only the
        // tree preview on the right, the dialog now reads as a
        // tight glance card. Cleaner footprint, less ceremony.
        className="max-w-md p-0 overflow-hidden gap-0 bg-white/[0.06] border-white/10 text-white shadow-2xl"
        style={{
          backdropFilter: 'blur(20px) saturate(140%)',
          WebkitBackdropFilter: 'blur(20px) saturate(140%)',
        }}
      >
        {/* 2.5.0+: title alone in the header — the X close was
            dropped per the design call; Escape, outside-click, and
            the footer Cancel button cover the dismissal cases.
            `hideClose` on DialogContent suppresses the default
            absolute-positioned X from the primitive too. */}
        <DialogHeader className="pl-2 pr-5 pt-0 pb-[15px] space-y-0">
          <DialogTitle className="flex items-center gap-2 text-white">
            <Sparkles className="w-5 h-5 text-primary" />
            Create from template
          </DialogTitle>
          {/* 2.5.0+: long marketing-style description dropped per
              the design call — the modal is tight enough that the
              title alone tells the story. Kept as sr-only so
              screen readers still get a sentence of context. */}
          <DialogDescription className="sr-only">
            Create a multi-level folder structure from a template.
          </DialogDescription>
        </DialogHeader>

        {screen === 'pick' && (
          <PickScreen
            chosen={chosen}
            setChosen={setChosen}
            preview={previewTemplate}
            onUse={() => {
              if (chosen) setScreen('form')
            }}
            onCancel={() => onOpenChange(false)}
          />
        )}

        {screen === 'form' && chosen && (
          <FormScreen
            template={chosen}
            projects={projects}
            projectId={projectId}
            setProjectId={setProjectId}
            day={day}
            setDay={setDay}
            episode={episode}
            setEpisode={setEpisode}
            campaign={campaign}
            setCampaign={setCampaign}
            actors={actors}
            addActor={addActor}
            removeActor={removeActor}
            updateActor={updateActor}
            submitting={submitting}
            canSubmit={canSubmit}
            onBack={() => setScreen('pick')}
            onSubmit={handleSubmit}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

// ─── Screen 1: pick a template ────────────────────────────────────────

function PickScreen({
  chosen,
  setChosen,
  preview,
  onUse,
  onCancel,
}: {
  chosen: TemplateId | null
  setChosen: (t: TemplateId) => void
  preview: TemplateId
  onUse: () => void
  onCancel: () => void
}) {
  return (
    <>
      {/* 2.5.1+: hairline `border-white/10` vertical divider between
          the picker (left) and the preview (right) — gives the two
          panes a clear visual edge without the heavier panel chrome
          we had before. */}
      <div className="grid grid-cols-[130px_1fr] px-4 pt-1 pb-0">
        {/* Left: minimal template list — plain text rows. No bg,
            no ring, no shadow — pure typography with the divider
            on its right edge separating it from the preview. */}
        <div className="flex flex-col gap-2 py-1 pr-3 border-r border-white/10">
          {(Object.keys(TEMPLATE_META) as TemplateId[]).map((id) => {
            const meta = TEMPLATE_META[id]
            const Icon = meta.icon
            const isActive = chosen === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => setChosen(id)}
                // 2.5.1+: subtle glass bg restored on the option
                // buttons — pure text rows felt too flat. Inactive
                // gets a hairline white/04 wash with a thin ring;
                // active swaps to a brand-blue tint (primary/15
                // bg + primary/40 ring + primary text) so the
                // selection reads clearly without shouting.
                className={`text-left flex items-center gap-2 px-2.5 py-2 rounded-md ring-1 transition-colors ${
                  isActive
                    ? 'bg-primary/15 ring-primary/40 text-primary'
                    : 'bg-white/[0.04] ring-white/10 text-white/80 hover:bg-white/[0.08] hover:ring-white/20 hover:text-white'
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${meta.accent}`} />
                <span className="text-sm font-medium truncate">{meta.title}</span>
              </button>
            )
          })}
        </div>

        {/* Right: structure preview only — no title, no blurb. */}
        <div className="py-2 pl-4">
          <div className="text-[11px] uppercase tracking-wider text-white/45 mb-2">
            Structure preview
          </div>
          <TreePreview template={preview} />
        </div>
      </div>

      {/* 2.5.1+: naked centered buttons — no panel, no ring, no bg
          wrapper. Cancel is a subtle ghost-text button; Use this
          template is the brand-blue primary CTA. Centered so the
          modal feels balanced now that it's narrower. */}
      <div className="flex justify-center items-center gap-3 px-4 pt-5 pb-1 -mb-2">
        {/* 2.5.1+: Cancel as a glass pill matching the Save Changes /
            Back buttons elsewhere — `bg-white/[0.06]` + ring +
            backdrop blur. Keeps the centered footer balanced
            against the brand-blue primary CTA. */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          // 2.5.1+: `h-auto py-2.5` bumps the internal vertical
          // padding to ~10px so the button sits taller and feels
          // less cramped next to the brand-blue primary CTA. The
          // fixed `h-9` from size="sm" gets overridden.
          className="h-auto py-2.5 ring-1 ring-white/15 hover:ring-white/25 text-white hover:text-white shadow-none"
          style={{
            backgroundColor: 'rgba(255, 255, 255, 0.06)',
            backdropFilter: 'blur(12px) saturate(140%)',
            WebkitBackdropFilter: 'blur(12px) saturate(140%)',
          }}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!chosen}
          onClick={onUse}
          className="h-auto py-2.5"
        >
          Use this template
        </Button>
      </div>
    </>
  )
}

function TreePreview({ template }: { template: TemplateId }) {
  const sample = TEMPLATE_META[template].sample
  if (template === 'youtube') {
    return (
      <div className="font-mono text-xs space-y-1 text-white/75">
        <TreeRow depth={0} label={sample.day!} kind="folder-top" />
        <TreeRow depth={1} label={sample.episode!} kind="folder" />
        <TreeRow depth={2} label="01_IN EDIT" kind="folder" />
        <TreeRow depth={2} label="02_CLEAN" kind="folder" />
        <TreeRow depth={2} label="03_FINAL" kind="folder" />
      </div>
    )
  }
  return (
    <div className="font-mono text-xs space-y-1 text-white/75">
      <TreeRow depth={0} label={sample.campaign!} kind="folder-top" />
      {sample.actors!.map((actor) => (
        <div key={actor} className="space-y-1">
          <TreeRow depth={1} label={actor} kind="folder" />
          <TreeRow depth={2} label="9:16" kind="folder" />
          <TreeRow depth={2} label="4:5" kind="folder" />
        </div>
      ))}
    </div>
  )
}

function TreeRow({
  depth,
  label,
  kind,
}: {
  depth: number
  label: string
  kind: 'folder' | 'folder-top'
}) {
  return (
    <div
      className={`flex items-center gap-1.5 ${
        kind === 'folder-top' ? 'font-semibold text-white' : ''
      }`}
      style={{ paddingLeft: `${depth * 18}px` }}
    >
      <Folder
        className={`w-3.5 h-3.5 shrink-0 ${
          kind === 'folder-top' ? 'text-primary' : 'text-white/45'
        }`}
      />
      <span className="truncate">{label}</span>
    </div>
  )
}

// ─── Screen 2: form ───────────────────────────────────────────────────

function FormScreen({
  template,
  projects,
  projectId,
  setProjectId,
  day,
  setDay,
  episode,
  setEpisode,
  campaign,
  setCampaign,
  actors,
  addActor,
  removeActor,
  updateActor,
  submitting,
  canSubmit,
  onBack,
  onSubmit,
}: {
  template: TemplateId
  projects: ProjectOption[]
  projectId: string
  setProjectId: (v: string) => void
  day: string
  setDay: (v: string) => void
  episode: string
  setEpisode: (v: string) => void
  campaign: string
  setCampaign: (v: string) => void
  actors: string[]
  addActor: () => void
  removeActor: (i: number) => void
  updateActor: (i: number, v: string) => void
  submitting: boolean
  canSubmit: boolean
  onBack: () => void
  onSubmit: () => void
}) {
  const meta = TEMPLATE_META[template]
  const Icon = meta.icon

  return (
    <>
      <div className="border-t border-white/10 px-5 py-4 max-h-[60vh] overflow-y-auto">
        <div className="flex items-center gap-2 mb-4">
          <Icon className={`w-4 h-4 ${meta.accent}`} />
          <div className="text-sm font-medium text-white">{meta.title} template</div>
        </div>

        <div className="space-y-4">
          {/* Project picker — first thing on every template */}
          <div className="space-y-1.5">
            <Label htmlFor="tpl-project" className="text-white/80">Project</Label>
            <select
              id="tpl-project"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full h-9 px-3 rounded-md border border-white/10 bg-white/[0.04] text-sm text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
            >
              <option value="">— Select a project —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </div>

          {template === 'youtube' && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-day" className="text-white/80">Shoot day folder</Label>
                <Input
                  id="tpl-day"
                  placeholder="e.g., Day7"
                  value={day}
                  onChange={(e) => setDay(e.target.value)}
                  className="bg-white/[0.04] border-white/10 text-white placeholder:text-white/35 focus-visible:ring-primary/60"
                />
                <p className="text-[11px] text-white/55">
                  Top-level folder. If it already exists in this project, we'll
                  pick "Day7 (1)" and so on so we never overwrite.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-episode" className="text-white/80">Episode name</Label>
                <Input
                  id="tpl-episode"
                  placeholder="e.g., Episode 12 — First Date"
                  value={episode}
                  onChange={(e) => setEpisode(e.target.value)}
                  className="bg-white/[0.04] border-white/10 text-white placeholder:text-white/35 focus-visible:ring-primary/60"
                />
                <p className="text-[11px] text-white/55">
                  This folder will be created inside the shoot-day folder and
                  will contain 01_IN EDIT, 02_CLEAN, 03_FINAL.
                </p>
              </div>
            </>
          )}

          {template === 'ugc' && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-campaign" className="text-white/80">Campaign name</Label>
                <Input
                  id="tpl-campaign"
                  placeholder="e.g., Spring 2026 Push"
                  value={campaign}
                  onChange={(e) => setCampaign(e.target.value)}
                  className="bg-white/[0.04] border-white/10 text-white placeholder:text-white/35 focus-visible:ring-primary/60"
                />
                <p className="text-[11px] text-white/55">
                  Top-level folder. Auto-renamed if the name is taken.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-white/80">Actors</Label>
                <div className="space-y-2">
                  {actors.map((value, i) => (
                    <div key={i} className="flex gap-2">
                      <Input
                        placeholder={`Actor ${i + 1} (e.g., Maria)`}
                        value={value}
                        onChange={(e) => updateActor(i, e.target.value)}
                        className="bg-white/[0.04] border-white/10 text-white placeholder:text-white/35 focus-visible:ring-primary/60"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removeActor(i)}
                        disabled={actors.length <= 1}
                        className="shrink-0 text-white/70 hover:text-white hover:bg-white/5"
                        aria-label={`Remove actor ${i + 1}`}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={addActor}
                  className="mt-1 text-white/80 hover:text-white hover:bg-white/5"
                >
                  <Plus className="w-3.5 h-3.5 mr-1" />
                  Add actor
                </Button>
                <p className="text-[11px] text-white/55">
                  Each actor gets its own folder with 9:16 and 4:5 subfolders.
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 2.5.0+: same floating action bar treatment as PickScreen. */}
      <div className="flex justify-between gap-2 px-4 py-2.5 m-3 rounded-xl bg-white/[0.05] backdrop-blur-md ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)]">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={submitting} className="text-white/80 hover:text-white hover:bg-white/5">
          <ArrowLeft className="w-3.5 h-3.5 mr-1" />
          Back
        </Button>
        <Button size="sm" onClick={onSubmit} disabled={!canSubmit || submitting}>
          {submitting ? 'Creating…' : 'Create folders'}
        </Button>
      </div>
    </>
  )
}
