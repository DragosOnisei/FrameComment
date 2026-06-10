import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CollapsibleSection } from '@/components/ui/collapsible-section'
import { Upload, Trash2, Image as ImageIcon } from 'lucide-react'
import { useRef } from 'react'
import { useTranslations } from 'next-intl'
import { EmailTemplatesEditor } from '@/components/settings/EmailTemplatesSection'

interface BrandingSectionProps {
  companyName: string
  setCompanyName: (value: string) => void
  appDomain: string
  setAppDomain: (value: string) => void
  /** 2.4.0+: optional short-link domain (e.g. "fcmt.io"). */
  shortLinkDomain: string
  setShortLinkDomain: (value: string) => void
  brandingLogoUrl: string | null
  onUploadLogo: (file: File) => Promise<void>
  onRemoveLogo: () => Promise<void>
  logoUploading: boolean
  logoError?: string | null
  emailHeaderStyle: string
  setEmailHeaderStyle: (value: string) => void
  show: boolean
  setShow: (value: boolean) => void
  collapsible?: boolean
}

export function BrandingSection({
  companyName,
  setCompanyName,
  appDomain,
  setAppDomain,
  shortLinkDomain,
  setShortLinkDomain,
  brandingLogoUrl,
  onUploadLogo,
  onRemoveLogo,
  logoUploading,
  logoError,
  emailHeaderStyle,
  setEmailHeaderStyle,
  show,
  setShow,
  collapsible,
}: BrandingSectionProps) {
  const t = useTranslations('settings')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  return (
    <CollapsibleSection
      className="border-0 bg-white/[0.04] ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] text-white"
      style={{
        backdropFilter: 'blur(20px) saturate(140%)',
        WebkitBackdropFilter: 'blur(20px) saturate(140%)',
      }}
      title={t('branding.title')}
      open={show}
      onOpenChange={setShow}
      contentClassName="space-y-4 border-t border-white/10 pt-4"
      collapsible={collapsible}
    >
      {/* Company Name */}
      <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
        <Label htmlFor="companyName" className="text-white">{t('appearance.companyName')}</Label>
        <Input
          id="companyName"
          type="text"
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          placeholder={t('appearance.companyNamePlaceholder')}
          className="bg-white/[0.04] border-white/10 text-white placeholder:text-white/45 focus-visible:ring-primary/60"
        />
        <p className="text-xs text-white/55">
          {t('appearance.companyNameHint')}
        </p>
      </div>

      {/* Custom Logo Upload */}
      <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
        <Label className="text-white">{t('appearance.customLogo')}</Label>
        <input
          ref={fileInputRef}
          type="file"
          accept=".svg,image/svg+xml"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) {
              onUploadLogo(file)
              e.target.value = ''
            }
          }}
        />
        <div className="flex items-center gap-4">
          <div className="w-24 h-16 rounded-xl bg-white/[0.04] ring-1 ring-white/10 flex items-center justify-center overflow-hidden">
            {brandingLogoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={brandingLogoUrl} alt={t('appearance.logoPreview')} className="w-full h-full object-contain" />
            ) : (
              <ImageIcon className="w-6 h-6 text-white/45" />
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.06] ring-1 ring-white/10 text-white text-sm hover:bg-white/[0.1] hover:ring-white/20 transition-colors disabled:opacity-50"
              onClick={() => fileInputRef.current?.click()}
              disabled={logoUploading}
            >
              <Upload className="w-4 h-4" />
              {logoUploading ? t('appearance.validating') : brandingLogoUrl ? t('appearance.replaceLogo') : t('appearance.uploadLogo')}
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.06] ring-1 ring-white/10 text-red-400 text-sm hover:bg-red-500/10 hover:ring-red-500/30 transition-colors disabled:opacity-50"
              onClick={onRemoveLogo}
              disabled={!brandingLogoUrl || logoUploading}
            >
              <Trash2 className="w-4 h-4" />
              {t('appearance.removeLogo')}
            </button>
          </div>
        </div>
        {logoError ? (
          <p className="text-xs text-red-400 font-medium">{logoError}</p>
        ) : (
          <p className="text-xs text-white/55">
            {t('appearance.logoHint')}
          </p>
        )}
      </div>

      {/* Application Domain */}
      <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
        <Label htmlFor="appDomain" className="text-white">{t('appearance.appDomain')}</Label>
        <Input
          id="appDomain"
          type="text"
          value={appDomain}
          onChange={(e) => setAppDomain(e.target.value)}
          placeholder={t('appearance.appDomainPlaceholder')}
          className="bg-white/[0.04] border-white/10 text-white placeholder:text-white/45 focus-visible:ring-primary/60"
        />
        <p className="text-xs text-white/55">
          {t('appearance.appDomainHint')}
        </p>
      </div>

      {/* 2.4.0+: Short-link domain for Frame.io-style tidy URLs. */}
      <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
        <Label htmlFor="shortLinkDomain" className="text-white">Short link domain</Label>
        <Input
          id="shortLinkDomain"
          type="text"
          value={shortLinkDomain}
          onChange={(e) => setShortLinkDomain(e.target.value)}
          placeholder="fcmt.io"
          className="bg-white/[0.04] border-white/10 text-white placeholder:text-white/45 focus-visible:ring-primary/60"
        />
        <p className="text-xs text-white/55">
          Optional dedicated domain that fronts the URL shortener
          (Frame.io-style). When set, &quot;Copy share link&quot;
          gives you a tidy{' '}
          <code className="font-mono text-white/75">https://{shortLinkDomain || 'fcmt.io'}/aBc12XyZ</code>{' '}
          instead of the long signed URL.
        </p>
      </div>

      {/* Email Templates */}
      <EmailTemplatesEditor
        emailHeaderStyle={emailHeaderStyle}
        setEmailHeaderStyle={setEmailHeaderStyle}
      />
    </CollapsibleSection>
  )
}
