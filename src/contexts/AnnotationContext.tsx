'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from 'react'
import { useAnnotationDrawing } from '@/hooks/useAnnotationDrawing'
import { AnnotationData } from '@/types/annotations'

type AnnotationDrawing = ReturnType<typeof useAnnotationDrawing>

interface PendingAnnotation {
  annotations: AnnotationData
  timecode: string
  timecodeEnd?: string | null
}

interface AnnotationContextValue {
  // Underlying drawing state (tools, colours, shapes, undo/redo).
  drawing: AnnotationDrawing

  // Whether the canvas is currently active (mouse captures the video, toolbar
  // appears in the comment input).
  isDrawingMode: boolean

  // Timecodes captured when entering drawing mode. Used by VideoPlayer when
  // saving the annotation.
  drawingTimecodeStart: string
  drawingTimecodeEnd: string | null

  // The most recently committed (but not yet posted) annotation. Rendered as
  // a preview overlay until the user posts the comment.
  pendingAnnotation: PendingAnnotation | null

  // The comment whose saved annotations are currently being shown on the
  // video. Set by MessageBubble click; cleared on seek / outside click.
  // null = no annotations shown (default behaviour).
  activeCommentId: string | null
  setActiveCommentId: (id: string | null) => void

  // Imperative API consumed by VideoPlayer / CommentInput.
  startDrawingMode: (timecodeStart: string, timecodeEnd?: string | null) => void
  finishDrawingMode: (selectedVideoId?: string | null) => void
  cancelDrawingMode: () => void
  clearPendingAnnotation: () => void
}

const AnnotationContext = createContext<AnnotationContextValue | null>(null)

export function AnnotationProvider({ children }: { children: ReactNode }) {
  const drawing = useAnnotationDrawing()
  const [isDrawingMode, setIsDrawingMode] = useState(false)
  const [drawingTimecodeStart, setDrawingTimecodeStart] = useState('00:00:00:00')
  const [drawingTimecodeEnd, setDrawingTimecodeEnd] = useState<string | null>(null)
  const [pendingAnnotation, setPendingAnnotation] = useState<PendingAnnotation | null>(null)
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null)

  const startDrawingMode = useCallback(
    (timecodeStart: string, timecodeEnd?: string | null) => {
      setDrawingTimecodeStart(timecodeStart)
      setDrawingTimecodeEnd(timecodeEnd ?? null)
      drawing.reset()
      setPendingAnnotation(null)
      setIsDrawingMode(true)
    },
    [drawing]
  )

  const finishDrawingMode = useCallback(
    (selectedVideoId?: string | null) => {
      const data = drawing.getAnnotationData()
      setIsDrawingMode(false)
      if (data) {
        setPendingAnnotation({
          annotations: data,
          timecode: drawingTimecodeStart,
          timecodeEnd: drawingTimecodeEnd,
        })
        window.dispatchEvent(
          new CustomEvent('annotationComplete', {
            detail: {
              annotations: data,
              timecodeStart: drawingTimecodeStart,
              timecodeEnd: drawingTimecodeEnd,
              videoId: selectedVideoId,
            },
          })
        )
      }
    },
    [drawing, drawingTimecodeStart, drawingTimecodeEnd]
  )

  const cancelDrawingMode = useCallback(() => {
    setIsDrawingMode(false)
  }, [])

  const clearPendingAnnotation = useCallback(() => {
    setPendingAnnotation(null)
  }, [])

  // Listen for "post comment / clear annotation" lifecycle events so the
  // preview overlay disappears when the user actually posts (or discards).
  useEffect(() => {
    const clear = () => setPendingAnnotation(null)
    window.addEventListener('commentPosted', clear)
    window.addEventListener('annotationCleared', clear)
    return () => {
      window.removeEventListener('commentPosted', clear)
      window.removeEventListener('annotationCleared', clear)
    }
  }, [])

  const value: AnnotationContextValue = {
    drawing,
    isDrawingMode,
    drawingTimecodeStart,
    drawingTimecodeEnd,
    pendingAnnotation,
    activeCommentId,
    setActiveCommentId,
    startDrawingMode,
    finishDrawingMode,
    cancelDrawingMode,
    clearPendingAnnotation,
  }

  return <AnnotationContext.Provider value={value}>{children}</AnnotationContext.Provider>
}

export function useAnnotation(): AnnotationContextValue {
  const ctx = useContext(AnnotationContext)
  if (!ctx) {
    throw new Error('useAnnotation must be used within an AnnotationProvider')
  }
  return ctx
}

/**
 * Optional consumer that returns null when no provider is present. Useful in
 * components that may render outside the share/admin layouts (e.g. shared
 * widgets).
 */
export function useOptionalAnnotation(): AnnotationContextValue | null {
  return useContext(AnnotationContext)
}
