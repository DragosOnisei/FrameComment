import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { CollapsibleSection } from '@/components/ui/collapsible-section'
import { ShieldCheck } from 'lucide-react'
import { useTranslations } from 'next-intl'

interface PrivacySectionProps {
  privacyDisclosureEnabled: boolean
  setPrivacyDisclosureEnabled: (value: boolean) => void
  privacyDisclosureText: string
  setPrivacyDisclosureText: (value: string) => void
  show: boolean
  setShow: (value: boolean) => void
  collapsible?: boolean
}

export function PrivacySection({
  privacyDisclosureEnabled,
  setPrivacyDisclosureEnabled,
  privacyDisclosureText,
  setPrivacyDisclosureText,
  show,
  setShow,
  collapsible,
}: PrivacySectionProps) {
  const t = useTranslations('settings')

  return (
    <CollapsibleSection
      className="border-0 bg-white/[0.04] ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] text-white"
      style={{
        backdropFilter: 'blur(20px) saturate(140%)',
        WebkitBackdropFilter: 'blur(20px) saturate(140%)',
      }}
      title={t('privacy.title')}
      open={show}
      onOpenChange={setShow}
      contentClassName="space-y-4 border-t border-white/10 pt-4"
      collapsible={collapsible}
    >
      <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label className="flex items-center gap-2 text-white">
              <ShieldCheck className="w-4 h-4" />
              {t('appearance.privacyDisclosure')}
            </Label>
            <p className="text-xs text-white/55">
              {t('appearance.privacyDisclosureDescription')}
            </p>
          </div>
          <Switch
            checked={privacyDisclosureEnabled}
            onCheckedChange={setPrivacyDisclosureEnabled}
          />
        </div>
        {privacyDisclosureEnabled && (
          <div className="space-y-2">
            <Label className="text-white">{t('appearance.privacyDisclosureCustomText')}</Label>
            <textarea
              value={privacyDisclosureText}
              onChange={(e) => setPrivacyDisclosureText(e.target.value)}
              placeholder={t('appearance.privacyDisclosurePlaceholder')}
              rows={4}
              className="w-full rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white placeholder:text-white/45 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
            />
            <p className="text-xs text-white/55">
              {t('appearance.privacyDisclosureHint')}
            </p>
          </div>
        )}
      </div>
    </CollapsibleSection>
  )
}
