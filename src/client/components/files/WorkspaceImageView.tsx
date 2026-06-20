import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { cn } from '@/client/lib/utils'

const MIN = 0.25
const MAX = 8
const clamp = (v: number) => Math.min(MAX, Math.max(MIN, v))

interface WorkspaceImageViewProps {
  src: string
  alt: string
}

/**
 * Image viewer for the Files section: wheel + button zoom, fit-to-screen reset,
 * and click-drag panning once zoomed in. No dependency — a CSS transform on a
 * `<img>` that fits the pane (object-contain) at scale 1.
 */
export function WorkspaceImageView({ src, alt }: WorkspaceImageViewProps) {
  const { t } = useTranslation()
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  const zoomTo = (next: number) => {
    const s = clamp(next)
    setScale(s)
    if (s === 1) setOffset({ x: 0, y: 0 })
  }
  const fit = () => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }

  const onWheel = (e: React.WheelEvent) => {
    zoomTo(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15))
  }
  const onPointerDown = (e: React.PointerEvent) => {
    if (scale <= 1) return
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return
    setOffset({ x: drag.current.ox + (e.clientX - drag.current.x), y: drag.current.oy + (e.clientY - drag.current.y) })
  }
  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-muted/30">
      <div
        className={cn('flex flex-1 items-center justify-center overflow-hidden', scale > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-default')}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
          className="max-h-full max-w-full select-none object-contain transition-transform duration-75"
        />
      </div>
      <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-popover/95 px-1.5 py-1 shadow-md backdrop-blur">
        <Button size="icon-xs" variant="ghost" onClick={() => zoomTo(scale / 1.25)} title={t('files.editor.zoomOut')} aria-label={t('files.editor.zoomOut')}>
          <ZoomOut className="size-4" />
        </Button>
        <button
          type="button"
          onClick={fit}
          className="min-w-12 rounded px-1.5 text-center text-xs tabular-nums text-muted-foreground hover:text-foreground"
          title={t('files.editor.fit')}
        >
          {Math.round(scale * 100)}%
        </button>
        <Button size="icon-xs" variant="ghost" onClick={() => zoomTo(scale * 1.25)} title={t('files.editor.zoomIn')} aria-label={t('files.editor.zoomIn')}>
          <ZoomIn className="size-4" />
        </Button>
        <Button size="icon-xs" variant="ghost" onClick={fit} title={t('files.editor.fit')} aria-label={t('files.editor.fit')}>
          <Maximize2 className="size-4" />
        </Button>
      </div>
    </div>
  )
}
