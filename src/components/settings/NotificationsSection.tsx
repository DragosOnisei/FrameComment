'use client'

import { CollapsibleSection } from '@/components/ui/collapsible-section'
import { EmailSettingsContent, type EmailSettingsContentProps } from '@/components/settings/EmailSettingsSection'
import { ExternalNotificationsContent } from '@/components/settings/ExternalNotificationsSection'
import { WebPushSection } from '@/components/settings/WebPushSection'
import { useState } from 'react'
import { useTranslations } from 'next-intl'

export type NotificationsTab = 'email' | 'external' | 'browser'
const ALL_TABS: ReadonlyArray<NotificationsTab> = ['email', 'external', 'browser']

interface NotificationsSectionProps extends EmailSettingsContentProps {
  show: boolean
  setShow: (value: boolean) => void
  collapsible?: boolean
  /**
   * 7.8.2: which tabs exist. The whole section had been off the Settings
   * sidebar since 3.0.0 ("no managed delivery infrastructure yet"), which
   * also hid the Browser tab — the only place a person can see their push
   * devices, rename them, pick company-wide events, and (7.8.1) run the
   * three-step test. Browser push needs none of that infrastructure (VAPID
   * keys are the company's own; delivery is the browser vendor's), so the
   * page now mounts this section with `['browser']` and the email/external
   * tabs stay hidden exactly as before. One tab: no tab strip.
   */
  tabs?: ReadonlyArray<NotificationsTab>
}

export function NotificationsSection({
  show,
  setShow,
  collapsible,
  tabs = ALL_TABS,
  ...emailProps
}: NotificationsSectionProps) {
  const [activeTab, setActiveTab] = useState<NotificationsTab>(tabs[0] ?? 'browser')
  const t = useTranslations('settings')

  return (
    <CollapsibleSection
      className="border-0 bg-white/[0.04] ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] text-white"
      style={{
        backdropFilter: 'blur(20px) saturate(140%)',
        WebkitBackdropFilter: 'blur(20px) saturate(140%)',
      }}
      title={t('notifications.title')}
      open={show}
      onOpenChange={setShow}
      contentClassName="space-y-6 border-t border-white/10 pt-6"
      collapsible={collapsible}
    >
          {tabs.length > 1 && (
          <div
            role="tablist"
            aria-label={t('notifications.title')}
            className="inline-flex w-full gap-2"
          >
            {tabs.includes('email') && (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'email'}
              aria-controls="notifications-tabpanel-email"
              className={[
                'flex-1 px-3 py-2 text-sm font-medium rounded-lg ring-1 transition-colors',
                activeTab === 'email'
                  ? 'bg-primary/15 text-primary ring-primary/40'
                  : 'bg-white/[0.04] text-white/75 ring-white/10 hover:bg-white/[0.08] hover:text-white',
              ].join(' ')}
              onClick={() => setActiveTab('email')}
            >
              {t('notifications.emailTab')}
            </button>
            )}
            {tabs.includes('external') && (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'external'}
              aria-controls="notifications-tabpanel-external"
              className={[
                'flex-1 px-3 py-2 text-sm font-medium rounded-md border transition-colors',
                activeTab === 'external'
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background text-muted-foreground border-border hover:bg-accent hover:text-foreground',
              ].join(' ')}
              onClick={() => setActiveTab('external')}
            >
              {t('notifications.pushTab')}
            </button>
            )}
            {tabs.includes('browser') && (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'browser'}
              aria-controls="notifications-tabpanel-browser"
              className={[
                'flex-1 px-3 py-2 text-sm font-medium rounded-md border transition-colors',
                activeTab === 'browser'
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background text-muted-foreground border-border hover:bg-accent hover:text-foreground',
              ].join(' ')}
              onClick={() => setActiveTab('browser')}
            >
              {t('notifications.browserPushTab')}
            </button>
            )}
          </div>
          )}

          {tabs.includes('email') && activeTab === 'email' && (
            <div id="notifications-tabpanel-email" role="tabpanel" className="space-y-4">
              <div className="text-xs text-white/55">
                {t('notifications.emailDescription')}
              </div>
              <EmailSettingsContent {...emailProps} />
            </div>
          )}
          {tabs.includes('external') && activeTab === 'external' && (
            <div id="notifications-tabpanel-external" role="tabpanel" className="space-y-4">
              <div className="text-xs text-white/55">
                {t('notifications.pushDescription')}
              </div>
              <ExternalNotificationsContent active={show && activeTab === 'external'} showIntro={false} />
            </div>
          )}
          {tabs.includes('browser') && activeTab === 'browser' && (
            <div id="notifications-tabpanel-browser" role="tabpanel" className="space-y-4">
              <div className="text-xs text-white/55">
                {t('notifications.browserPushDescription')}
              </div>
              <WebPushSection active={show && activeTab === 'browser'} />
            </div>
          )}
    </CollapsibleSection>
  )
}
