'use client'

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import {
  ArrowRight,
  Minus,
  Square,
  Pencil,
  Undo2,
  Redo2,
  ChevronLeft,
} from 'lucide-react'
import { ANNOTATION_COLORS, DrawingTool } from '@/types/annotations'
import { useAnnotation } from '@/contexts/AnnotationContext'

interface ToolDef {
  id: DrawingTool
  Icon: typeof ArrowRight
  labelKey: string
}

const TOOLS: ToolDef[] = [
  { id: 'arrow', Icon: ArrowRight, labelKey: 'arrow' },
  { id: 'line', Icon: Minus, labelKey: 'line' },
  { id: 'rectangle', Icon: Square, labelKey: 'rectangle' },
  { id: 'freehand', Icon: Pencil, labelKey: 'marker' },
]

/**
 * Inline drawing toolbar rendered inside CommentInput when the user enters
 * drawing mode. Shape choice + colour + undo/redo + done/cancel — all in
 * one compact row, matching the Frame.io review interface.
 *
 * Keyboard shortcuts (also active globally while drawing mode is on):
 *   ⌘Z   undo
 *   ⌘⇧Z  redo
 *   Esc  cancel
 *   ⏎    done
 */
export default function AnnotationToolbarInline() {
  const t = useTranslations('controls')
  const { drawing, finishDrawingMode, cancelDrawingMode } = useAnnotation()

  const canUndo = drawing.undoStack.length > 0
  const canRedo = drawing.redoStack.length > 0
  const hasShapes = drawing.hasShapes

  /**
   * Single "back" button replaces Cancel/Done. If the user has drawn
   * something, leaving drawing mode commits it as a pending annotation; if
   * they haven't, it just cancels and returns to the regular comment input.
   */
  const handleBack = () => {
    if (hasShapes) {
      finishDrawingMode()
    } else {
      cancelDrawingMode()
    }
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return
      }

      const isMod = e.metaKey || e.ctrlKey
      if (isMod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) {
          if (canRedo) drawing.redo()
        } else {
          if (canUndo) drawing.undo()
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        cancelDrawingMode()
      } else if (e.key === 'Enter' && hasShapes) {
        e.preventDefault()
        finishDrawingMode()
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [canUndo, canRedo, hasShapes, drawing, finishDrawingMode, cancelDrawingMode])

  return (
    <div className="flex items-center gap-1 w-full">
      {/* Back: leaves drawing mode (commits if there are shapes). */}
      <button
        type="button"
        onClick={handleBack}
        className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        title={t('back') || 'Back'}
        aria-label={t('back') || 'Back'}
      >
        <ChevronLeft className="w-4 h-4" />
      </button>

      <div className="w-px h-5 bg-border mx-1" />

      {/* Tool buttons */}
      <div className="flex items-center gap-0.5">
        {TOOLS.map(({ id, Icon, labelKey }) => {
          const isActive = drawing.activeTool === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => drawing.setActiveTool(id)}
              className={`p-1.5 rounded-md transition-colors ${
                isActive
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              }`}
              title={t(labelKey)}
              aria-label={t(labelKey)}
              aria-pressed={isActive}
            >
              <Icon className="w-4 h-4" />
            </button>
          )
        })}
      </div>

      <div className="w-px h-5 bg-border mx-1" />

      {/* Colour swatches — small, with an inset ring instead of an outer
          ring so the selected swatch never overlaps its neighbours. */}
      <div className="flex items-center gap-2">
        {ANNOTATION_COLORS.map((color) => {
          const isActive = drawing.activeColor === color
          return (
            <button
              key={color}
              type="button"
              onClick={() => drawing.setActiveColor(color)}
              className={`w-3.5 h-3.5 rounded-full transition-transform hover:scale-110 ${
                isActive
                  ? 'ring-2 ring-inset ring-white/90 outline outline-1 outline-offset-1 outline-foreground/70'
                  : 'opacity-80'
              }`}
              style={{ backgroundColor: color }}
              title={color}
              aria-label={`Color ${color}`}
              aria-pressed={isActive}
            />
          )
        })}
      </div>

      <div className="w-px h-5 bg-border mx-1" />

      {/* Undo / Redo */}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={drawing.undo}
          disabled={!canUndo}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title={`${t('undo')} (⌘Z)`}
          aria-label={t('undo')}
        >
          <Undo2 className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={drawing.redo}
          disabled={!canRedo}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title={`${t('redo')} (⌘⇧Z)`}
          aria-label={t('redo')}
        >
          <Redo2 className="w-4 h-4" />
        </button>
      </div>

    </div>
  )
}
