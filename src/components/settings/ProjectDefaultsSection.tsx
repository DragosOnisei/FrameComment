import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CollapsibleSection } from '@/components/ui/collapsible-section'
import { useTranslations } from 'next-intl'

interface ProjectDefaultsSectionProps {
  defaultTimestampDisplay: string
  setDefaultTimestampDisplay: (value: string) => void
  defaultAllowClientAssetUpload: boolean
  setDefaultAllowClientAssetUpload: (value: boolean) => void
  defaultAllowReverseShare: boolean
  setDefaultAllowReverseShare: (value: boolean) => void
  defaultShowClientTutorial: boolean
  setDefaultShowClientTutorial: (value: boolean) => void
  defaultAllowAssetDownload: boolean
  setDefaultAllowAssetDownload: (value: boolean) => void
  show: boolean
  setShow: (value: boolean) => void
  collapsible?: boolean
}

export function ProjectDefaultsSection({
  defaultTimestampDisplay,
  setDefaultTimestampDisplay,
  defaultAllowClientAssetUpload,
  setDefaultAllowClientAssetUpload,
  defaultAllowReverseShare,
  setDefaultAllowReverseShare,
  defaultShowClientTutorial,
  setDefaultShowClientTutorial,
  defaultAllowAssetDownload,
  setDefaultAllowAssetDownload,
  show,
  setShow,
  collapsible,
}: ProjectDefaultsSectionProps) {
  const t = useTranslations('settings')

  return (
    <CollapsibleSection
      className="border-border"
      title={t('projectDefaults.title')}
      description={t('projectDefaults.description')}
      open={show}
      onOpenChange={setShow}
      contentClassName="space-y-4 border-t pt-4"
      collapsible={collapsible}
    >
      {/* ── Client Access ─────────────────────────────────────────────────── */}
      <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5 flex-1">
            <Label htmlFor="defaultAllowAssetDownload">{t('projectDefaults.defaultAllowAssetDownload')}</Label>
            <p className="text-xs text-white/55">
              {t('projectDefaults.defaultAllowAssetDownloadHint')}
            </p>
          </div>
          <Switch
            id="defaultAllowAssetDownload"
            checked={defaultAllowAssetDownload}
            onCheckedChange={setDefaultAllowAssetDownload}
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5 flex-1">
            <Label htmlFor="defaultAllowClientAssetUpload">{t('videoProcessing.clientAttachments')}</Label>
            <p className="text-xs text-white/55">
              {t('videoProcessing.clientAttachmentsHint')}
            </p>
          </div>
          <Switch
            id="defaultAllowClientAssetUpload"
            checked={defaultAllowClientAssetUpload}
            onCheckedChange={setDefaultAllowClientAssetUpload}
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5 flex-1">
            <Label htmlFor="defaultAllowReverseShare">{t('projectDefaults.defaultAllowReverseShare')}</Label>
            <p className="text-xs text-white/55">
              {t('projectDefaults.defaultAllowReverseShareHint')}
            </p>
          </div>
          <Switch
            id="defaultAllowReverseShare"
            checked={defaultAllowReverseShare}
            onCheckedChange={setDefaultAllowReverseShare}
          />
        </div>
      </div>

      {/* ── Presentation ──────────────────────────────────────────────────── */}
      <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5 flex-1">
            <Label htmlFor="defaultShowClientTutorial">{t('projectDefaults.defaultShowClientTutorial')}</Label>
            <p className="text-xs text-white/55">
              {t('projectDefaults.defaultShowClientTutorialHint')}
            </p>
          </div>
          <Switch
            id="defaultShowClientTutorial"
            checked={defaultShowClientTutorial}
            onCheckedChange={setDefaultShowClientTutorial}
          />
        </div>
        <div className="pt-2 mt-2 border-t border-border space-y-3">
          <Label>{t('videoProcessing.timestampDisplay')}</Label>
        <Select value={defaultTimestampDisplay} onValueChange={setDefaultTimestampDisplay}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="TIMECODE">{t('videoProcessing.timecode')}</SelectItem>
            <SelectItem value="AUTO">{t('videoProcessing.simpleTime')}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-white/55">
          {t('videoProcessing.timestampHint')}
        </p>
        </div>
      </div>
    </CollapsibleSection>
  )
}
