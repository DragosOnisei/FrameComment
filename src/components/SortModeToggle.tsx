'use client'

import { cn } from '@/lib/utils'
import { ArrowDownAZ, ArrowDownZA } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * 1.7.2+: segmented A-Z / Z-A sort toggle. Mirrors ViewModeToggle's
 * shape so the two header controls (Grid/Table + sort) read as a
 * unified pair of segmented pills in the AdminHeader center.
 */

export type SortMode = 'alphabetical' | 'alphabetical-reverse'

interface SortModeToggleProps {
  value: SortMode
  onChange: (value: SortMode) => void
  className?: string
}

export default function SortModeToggle({
  value,
  onChange,
  className,
}: SortModeToggleProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center rounded-md border bg-card p-0.5',
        className,
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => onChange('alphabetical')}
        aria-pressed={value === 'alphabetical'}
        className={cn(
          'h-8 w-8 text-muted-foreground hover:bg-accent hover:text-foreground',
          value === 'alphabetical' && 'bg-accent text-foreground',
        )}
        title="Sort A to Z"
      >
        <ArrowDownAZ className="h-4 w-4" />
        <span className="sr-only">Sort A to Z</span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => onChange('alphabetical-reverse')}
        aria-pressed={value === 'alphabetical-reverse'}
        className={cn(
          'h-8 w-8 text-muted-foreground hover:bg-accent hover:text-foreground',
          value === 'alphabetical-reverse' && 'bg-accent text-foreground',
        )}
        title="Sort Z to A"
      >
        <ArrowDownZA className="h-4 w-4" />
        <span className="sr-only">Sort Z to A</span>
      </Button>
    </div>
  )
}
