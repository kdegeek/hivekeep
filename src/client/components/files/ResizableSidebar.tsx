import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/client/lib/utils'

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

interface ResizableSidebarProps {
  children: ReactNode
  /** localStorage key for the persisted width. */
  storageKey: string
  defaultWidth?: number
  minWidth?: number
  maxWidth?: number
  className?: string
}

/**
 * Desktop-only resizable left panel: a fixed-width aside plus a drag handle,
 * width persisted in localStorage. Hidden below md (the tree lives in a Sheet
 * there). No dependency: pointer events + pointer capture (react-resizable-panels
 * is intentionally absent from the repo, files.md § 3.1).
 */
export function ResizableSidebar({
  children,
  storageKey,
  defaultWidth = 288,
  minWidth = 200,
  maxWidth = 560,
  className,
}: ResizableSidebarProps) {
  const { t } = useTranslation()
  const [width, setWidth] = useState(() => {
    const v = Number(localStorage.getItem(storageKey))
    return v >= minWidth && v <= maxWidth ? v : defaultWidth
  })
  const drag = useRef<{ startX: number; startW: number } | null>(null)

  useEffect(() => {
    localStorage.setItem(storageKey, String(width))
  }, [storageKey, width])

  const onDown = (e: React.PointerEvent) => {
    drag.current = { startX: e.clientX, startW: width }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return
    setWidth(clamp(drag.current.startW + (e.clientX - drag.current.startX), minWidth, maxWidth))
  }
  const onUp = (e: React.PointerEvent) => {
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') setWidth((w) => clamp(w - 16, minWidth, maxWidth))
    else if (e.key === 'ArrowRight') setWidth((w) => clamp(w + 16, minWidth, maxWidth))
  }

  return (
    <>
      <aside style={{ width }} className={cn('hidden shrink-0 md:flex md:flex-col', className)}>
        {children}
      </aside>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('files.resizeTree')}
        tabIndex={0}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onKeyDown={onKey}
        className="hidden w-1.5 shrink-0 cursor-col-resize touch-none border-r border-border transition-colors hover:bg-primary/40 focus-visible:bg-primary/40 focus-visible:outline-none md:block"
      />
    </>
  )
}
