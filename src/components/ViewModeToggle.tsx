'use client'

import { cn } from '@/lib/utils'
import { LayoutGrid, Table2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslations } from 'next-intl'

export type ViewMode = 'grid' | 'table'

interface ViewModeToggleProps {
  value: ViewMode
  onChange: (value: ViewMode) => void
  className?: string
}

export default function ViewModeToggle({ value, onChange, className }: ViewModeToggleProps) {
  const t = useTranslations('controls')
  return (
    <div className={cn('inline-flex items-center rounded-md bg-white/[0.06] backdrop-blur-md ring-1 ring-white/10 p-0.5', className)}>
      {/* 2.5.0+: active variant now uses the brand-blue tint
          (`bg-primary/15 text-primary`) — same recipe as the
          highlighted Projects link in AdminSidebar — so the whole
          chrome reads as one design family. Non-active hover
          stays the neutral muted hint. */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => onChange('grid')}
        aria-pressed={value === 'grid'}
        className={cn(
          'h-8 w-8 text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
          value === 'grid' && 'bg-primary/15 text-primary hover:bg-primary/15 hover:text-primary'
        )}
        title={t('gridView')}
      >
        <LayoutGrid className="h-4 w-4" />
        <span className="sr-only">{t('gridView')}</span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => onChange('table')}
        aria-pressed={value === 'table'}
        className={cn(
          'h-8 w-8 text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
          value === 'table' && 'bg-primary/15 text-primary hover:bg-primary/15 hover:text-primary'
        )}
        title={t('tableView')}
      >
        <Table2 className="h-4 w-4" />
        <span className="sr-only">{t('tableView')}</span>
      </Button>
    </div>
  )
}

