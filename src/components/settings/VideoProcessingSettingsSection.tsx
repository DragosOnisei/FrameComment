import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CollapsibleSection } from '@/components/ui/collapsible-section'
import { Button } from '@/components/ui/button'
import { RefreshCw, Image as ImageIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'

const WATERMARK_POSITIONS = ['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const

interface VideoProcessingSettingsSectionProps {
  defaultPreviewResolution: string
  setDefaultPreviewResolution: (value: string) => void
  defaultSkipTranscoding: boolean
  setDefaultSkipTranscoding: (value: boolean) => void
  defaultWatermarkEnabled: boolean
  setDefaultWatermarkEnabled: (value: boolean) => void
  defaultWatermarkText: string
  setDefaultWatermarkText: (value: string) => void
  defaultWatermarkPositions: string
  setDefaultWatermarkPositions: (value: string) => void
  defaultWatermarkOpacity: number
  setDefaultWatermarkOpacity: (value: number) => void
  defaultWatermarkFontSize: string
  setDefaultWatermarkFontSize: (value: string) => void
  defaultApplyPreviewLut: boolean
  setDefaultApplyPreviewLut: (value: boolean) => void
  show: boolean
  setShow: (value: boolean) => void
  collapsible?: boolean

  // 2.2.4+: optional global maintenance handlers. When BOTH are
  // supplied we render the "Maintenance" card under Default Preview
  // Resolution with two dedicated buttons (mirrors the per-project
  // Settings → Video Processing layout). The parent admin/settings
  // page owns the ConfirmDialog state + API calls — this component
  // just renders the buttons + their busy / result state.
  onReprocessAllVideos?: () => void
  onRegenerateAllThumbnails?: () => void
  reprocessingAllVideos?: boolean
  regeneratingAllThumbnails?: boolean
  maintenanceResult?: { kind: 'reprocess' | 'regen-thumbs'; count: number } | null
}

export function VideoProcessingSettingsSection({
  defaultPreviewResolution,
  setDefaultPreviewResolution,
  defaultSkipTranscoding,
  setDefaultSkipTranscoding,
  defaultWatermarkEnabled,
  setDefaultWatermarkEnabled,
  defaultWatermarkText,
  setDefaultWatermarkText,
  defaultWatermarkPositions,
  setDefaultWatermarkPositions,
  defaultWatermarkOpacity,
  setDefaultWatermarkOpacity,
  defaultWatermarkFontSize,
  setDefaultWatermarkFontSize,
  defaultApplyPreviewLut,
  setDefaultApplyPreviewLut,
  show,
  setShow,
  collapsible,
  onReprocessAllVideos,
  onRegenerateAllThumbnails,
  reprocessingAllVideos,
  regeneratingAllThumbnails,
  maintenanceResult,
}: VideoProcessingSettingsSectionProps) {
  const t = useTranslations('settings')

  const selectedPositions = defaultWatermarkPositions.split(',').map(p => p.trim()).filter(Boolean)

  function togglePosition(pos: string) {
    const current = new Set(selectedPositions)
    if (current.has(pos)) {
      current.delete(pos)
      // Must have at least one position
      if (current.size === 0) return
    } else {
      current.add(pos)
    }
    setDefaultWatermarkPositions(Array.from(current).join(','))
  }

  return (
    <CollapsibleSection
      className="border-0 bg-white/[0.04] ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] text-white"
      style={{
        backdropFilter: 'blur(20px) saturate(140%)',
        WebkitBackdropFilter: 'blur(20px) saturate(140%)',
      }}
      title={t('videoProcessing.title')}
      open={show}
      onOpenChange={setShow}
      contentClassName="space-y-4 border-t border-white/10 pt-4"
      collapsible={collapsible}
    >
      {/* 1.5.8: Skip Transcoding global default hidden — same
          reasoning as the per-project version: it's a one-way
          deployment choice, not something operators flip from
          settings. State + DB column kept; remove `{false && ` to
          surface it again. */}
      {false && (
      <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="defaultSkipTranscoding">{t('videoProcessing.skipTranscoding')}</Label>
            <p className="text-xs text-white/55">{t('videoProcessing.skipTranscodingHint')}</p>
          </div>
          <Switch id="defaultSkipTranscoding" checked={defaultSkipTranscoding} onCheckedChange={(checked) => {
            setDefaultSkipTranscoding(checked)
            if (checked) {
              setDefaultWatermarkEnabled(false)
              setDefaultApplyPreviewLut(false)
            }
          }} />
        </div>
        {defaultSkipTranscoding && (
          <p className="text-xs text-warning">{t('videoProcessing.skipTranscodingWarning')}</p>
        )}
      </div>
      )}

      {!defaultSkipTranscoding && (
      <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
        {/* 1.5.8: relabelled "Preview Resolution" → "Default Preview
            Resolution" to match the Project Settings copy. */}
        <Label className="text-white">Default Preview Resolution</Label>
        <Select value={defaultPreviewResolution} onValueChange={setDefaultPreviewResolution}>
          <SelectTrigger className="bg-white/[0.04] hover:bg-white/[0.08] border-0 ring-1 ring-white/10 text-white">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* 1.9.4+ Phase A: Auto matches the source — we always
                start with a fast 480p tier, then climb the ladder
                up to whatever the input actually resolves at (no
                upscaling). The three explicit caps stay for users
                who want a CPU / storage ceiling on big sources. */}
            <SelectItem value="auto">Auto (match source — recommended)</SelectItem>
            <SelectItem value="720p">{t('videoProcessing.resolution720')}</SelectItem>
            <SelectItem value="1080p">{t('videoProcessing.resolution1080')}</SelectItem>
            <SelectItem value="2160p">{t('videoProcessing.resolution2160')}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-white/55">
          The progressive ladder always starts at 480p for fast first playback, then climbs to the chosen cap (or the source resolution in Auto mode).
        </p>
      </div>
      )}

      {/* 2.2.4+: Maintenance card. Only renders when both handler
          props are wired up — that's how the admin Settings page
          opts in (and how we keep this component usable elsewhere
          without forcing them to plumb the handlers through). */}
      {!defaultSkipTranscoding && onReprocessAllVideos && onRegenerateAllThumbnails && (
        <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Maintenance</h3>
            <p className="text-xs text-white/55">
              These operations act on every video across every project. Originals are never touched — only derived files (encoded previews / thumbnails) are refreshed.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 gap-3 items-stretch">
            {/* 2.2.4+: same flex-column trick as the per-project
                settings card — flex-1 on the paragraph stretches it
                to fill available space, pinning the Button to the
                bottom regardless of description length. */}
            <div className="flex flex-col p-3 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
              <div className="flex items-center gap-2 mb-2">
                <RefreshCw className="w-4 h-4 text-white/55" />
                <span className="text-sm font-medium text-white">Re-process Videos</span>
              </div>
              <p className="text-xs text-white/55 leading-relaxed flex-1 mb-3">
                Smart sweep across every project: scans every video for missing quality tiers and only encodes the gaps. Already-finished tiers stay on disk and keep playing, and thumbnails are never touched.
              </p>
              <Button
                type="button"
                size="sm"
                onClick={onReprocessAllVideos}
                disabled={reprocessingAllVideos || regeneratingAllThumbnails}
                className="w-full bg-white/[0.06] hover:bg-white/[0.12] text-white ring-1 ring-white/10 hover:ring-white/20 border-0 backdrop-blur-md"
              >
                {reprocessingAllVideos ? (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                    Reprocessing…
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Re-process Videos
                  </>
                )}
              </Button>
            </div>

            <div className="flex flex-col p-3 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
              <div className="flex items-center gap-2 mb-2">
                <ImageIcon className="w-4 h-4 text-white/55" />
                <span className="text-sm font-medium text-white">Re-generate Thumbnails</span>
              </div>
              <p className="text-xs text-white/55 leading-relaxed flex-1 mb-3">
                Re-extracts a still frame for every video and writes it back. Lightweight — does not touch encoded tiers or playback.
              </p>
              <Button
                type="button"
                size="sm"
                onClick={onRegenerateAllThumbnails}
                disabled={regeneratingAllThumbnails || reprocessingAllVideos}
                className="w-full bg-white/[0.06] hover:bg-white/[0.12] text-white ring-1 ring-white/10 hover:ring-white/20 border-0 backdrop-blur-md"
              >
                {regeneratingAllThumbnails ? (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                    Enqueuing…
                  </>
                ) : (
                  <>
                    <ImageIcon className="w-4 h-4 mr-2" />
                    Re-generate Thumbnails
                  </>
                )}
              </Button>
            </div>
          </div>

          {maintenanceResult && (
            <div className="text-xs text-green-500">
              {maintenanceResult.kind === 'reprocess'
                ? `Queued ${maintenanceResult.count} video(s) for full re-process across all projects.`
                : `Queued ${maintenanceResult.count} thumbnail(s) for regeneration across all projects.`}
            </div>
          )}
        </div>
      )}

      {/* 1.5.8: Apply Preview LUT global default hidden. State + DB
          column kept; remove `{false && ` to expose. */}
      {false && !defaultSkipTranscoding && (
      <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="defaultApplyPreviewLut">{t('videoProcessing.applyPreviewLut')}</Label>
            <p className="text-xs text-white/55">{t('videoProcessing.applyPreviewLutHint')}</p>
          </div>
          <Switch id="defaultApplyPreviewLut" checked={defaultApplyPreviewLut} onCheckedChange={setDefaultApplyPreviewLut} />
        </div>
      </div>
      )}

      {/* 1.5.8: Watermark defaults card hidden — enable toggle plus
          its custom text, positions, font size, and opacity sub-
          controls. All state + DB columns preserved; remove `{false &&`
          to surface again. */}
      {false && !defaultSkipTranscoding && (
      <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="watermarkEnabled">{t('videoProcessing.enableWatermarks')}</Label>
            <p className="text-xs text-white/55">{t('videoProcessing.enableWatermarksHint')}</p>
          </div>
          <Switch id="watermarkEnabled" checked={defaultWatermarkEnabled} onCheckedChange={setDefaultWatermarkEnabled} />
        </div>

        {defaultWatermarkEnabled && (
          <div className="space-y-4 pt-2 mt-2 border-t border-border">
            <div className="space-y-2">
              <Label htmlFor="watermark">{t('videoProcessing.customWatermarkText')}</Label>
              <Input
                id="watermark"
                value={defaultWatermarkText}
                onChange={(e) => setDefaultWatermarkText(e.target.value)}
                placeholder={t('videoProcessing.watermarkPlaceholder')}
                maxLength={100}
              />
              <p className="text-xs text-white/55">
                {t('videoProcessing.watermarkHint')}
                <br />
                <span className="text-warning">{t('videoProcessing.watermarkCharsAllowed')}</span>
              </p>
            </div>

            <div className="space-y-2">
              <Label>{t('videoProcessing.watermarkPositions')}</Label>
              <p className="text-xs text-white/55">{t('videoProcessing.watermarkPositionsHint')}</p>
              <div className="flex flex-wrap gap-2 mt-1">
                {WATERMARK_POSITIONS.map((pos) => (
                  <button
                    key={pos}
                    type="button"
                    onClick={() => togglePosition(pos)}
                    className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${
                      selectedPositions.includes(pos)
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-muted/50 text-white/55 border-border hover:border-primary/50'
                    }`}
                  >
                    {t(`videoProcessing.position.${pos}`)}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label>{t('videoProcessing.watermarkFontSize')}</Label>
              <Select value={defaultWatermarkFontSize} onValueChange={setDefaultWatermarkFontSize}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="small">{t('videoProcessing.fontSizeSmall')}</SelectItem>
                  <SelectItem value="medium">{t('videoProcessing.fontSizeMedium')}</SelectItem>
                  <SelectItem value="large">{t('videoProcessing.fontSizeLarge')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>{t('videoProcessing.watermarkOpacity')}</Label>
                <span className="text-xs text-white/55">{defaultWatermarkOpacity}%</span>
              </div>
              <input
                type="range"
                min={10}
                max={100}
                step={5}
                value={defaultWatermarkOpacity}
                onChange={(e) => setDefaultWatermarkOpacity(Number(e.target.value))}
                className="w-full accent-primary"
              />
              <div className="flex justify-between text-xs text-white/55">
                <span>{t('videoProcessing.opacitySubtle')}</span>
                <span>{t('videoProcessing.opacityBold')}</span>
              </div>
            </div>
          </div>
        )}
      </div>
      )}
    </CollapsibleSection>
  )
}
