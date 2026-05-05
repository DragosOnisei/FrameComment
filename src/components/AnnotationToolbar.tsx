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
  Check,
  X,
} from 'lucide-react'
import {
  AnnotationColor,
  ANNOTATION_COLORS,
  DrawingTool,
} from '@/types/annotations'

interface AnnotationToolbarProps {
  activeTool: DrawingTool
  activeColor: AnnotationColor
  canUndo: boolean
  canRedo: boolean
  hasShapes: boolean
  onToolChange: (tool: DrawingTool) => void
  onColorChange: (color: AnnotationColor) => void
  onUndo: () => void
  onRedo: () => void
  onDone: () => void
  onCancel: () => void
}

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
 * Compact, inline-friendly drawing toolbar for FrameComment.
 *
 * Layout (single row):
 *   [tool buttons] | [colour swatches] | [undo/redo] | [cancel/done]
 *
 * Keyboard shortcuts:
 *   ⌘Z       — undo
 *   ⌘⇧Z      — redo
 *   Esc      — cancel
 *   Enter    — done (if there are shapes)
 */
export default function AnnotationToolbar({
  activeTool,
  activeColor,
  canUndo,
  canRedo,
  hasShapes,
  onToolChange,
  onColorChange,
  onUndo,
  onRedo,
  onDone,
  onCancel,
}: AnnotationToolbarProps) {
  const t = useTranslations('controls')
  const tCommon = useTranslations('common')

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept while the user is typing in a form field
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }

      const isMod = e.metaKey || e.ctrlKey

      if (isMod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) {
          if (canRedo) onRedo()
        } else {
          if (canUndo) onUndo()
        }
        return
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      } else if (e.key === 'Enter' && hasShapes) {
        e.preventDefault()
        onDone()
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [canUndo, canRedo, hasShapes, onUndo, onRedo, onCancel, onDone])

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 bg-black/85 backdrop-blur-sm rounded-xl px-2 py-1.5 shadow-2xl border border-white/10">
      {/* Tool buttons */}
      <div className="flex items-center gap-0.5">
        {TOOLS.map(({ id, Icon, labelKey }) => {
          const isActive = activeTool === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => onToolChange(id)}
              className={`p-1.5 sm:p-2 rounded-lg transition-colors ${
                isActive
                  ? 'bg-white/20 text-white'
                  : 'text-white/60 hover:text-white hover:bg-white/10'
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

      <div className="w-px h-5 bg-white/20 mx-1" />

      {/* Colour swatches */}
      <div className="flex items-center gap-1">
        {ANNOTATION_COLORS.map((color) => {
          const isActive = activeColor === color
          return (
            <button
              key={color}
              type="button"
              onClick={() => onColorChange(color)}
              className={`w-5 h-5 rounded-full transition-transform ${
                isActive ? 'scale-125 ring-2 ring-white/80 ring-offset-1 ring-offset-black/80' : 'hover:scale-110'
              }`}
              style={{ backgroundColor: color }}
              title={color}
              aria-label={`Colour ${color}`}
              aria-pressed={isActive}
            />
          )
        })}
      </div>

      <div className="w-px h-5 bg-white/20 mx-1" />

      {/* Undo / Redo */}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo}
          className={`p-1.5 sm:p-2 rounded-lg transition-colors ${
            canUndo
              ? 'text-white/60 hover:text-white hover:bg-white/10'
              : 'text-white/20 cursor-not-allowed'
          }`}
          title={`${t('undo')} (⌘Z)`}
          aria-label={t('undo')}
        >
          <Undo2 className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={onRedo}
          disabled={!canRedo}
          className={`p-1.5 sm:p-2 rounded-lg transition-colors ${
            canRedo
              ? 'text-white/60 hover:text-white hover:bg-white/10'
              : 'text-white/20 cursor-not-allowed'
          }`}
          title={`${t('redo')} (⌘⇧Z)`}
          aria-label={t('redo')}
        >
          <Redo2 className="w-4 h-4" />
        </button>
      </div>

      <div className="w-px h-5 bg-white/20 mx-1" />

      {/* Cancel / Done */}
      <button
        type="button"
        onClick={onCancel}
        className="px-2 py-1.5 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors flex items-center gap-1 text-xs"
        title={tCommon('cancel')}
      >
        <X className="w-3.5 h-3.5" />
        <span>{tCommon('cancel')}</span>
      </button>
      <button
        type="button"
        onClick={onDone}
        disabled={!hasShapes}
        className={`px-2 py-1.5 rounded-lg transition-colors flex items-center gap-1 text-xs ${
          hasShapes
            ? 'text-green-400 hover:text-green-300 hover:bg-green-500/20'
            : 'text-white/20 cursor-not-allowed'
        }`}
        title={t('saveAnnotation')}
      >
        <Check className="w-3.5 h-3.5" />
        <span>{tCommon('done')}</span>
      </button>
    </div>
  )
}
