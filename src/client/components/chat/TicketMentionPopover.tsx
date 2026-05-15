/**
 * Popover that displays ticket search results below the caret when the user
 * types `#` (or `slug#`) in the composer. Mirrors the visual language of the
 * @mention popover (same shell, same focus dance) so users only have one
 * pattern to learn.
 *
 * Selection is *always* driven by the parent — the popover never owns the
 * highlighted index. This keeps keyboard navigation in MessageInput where
 * the textarea already swallows the relevant key events.
 */
import { memo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/client/lib/utils'
import { Loader2 } from 'lucide-react'
import type { TicketSearchHit } from '@/client/hooks/useTicketSearch'

/** Tailwind background classes per ticket status. Kept aligned with the
 *  segmented progress bar on the projects page so the visual mapping is
 *  consistent across the app. */
const STATUS_DOT_CLASS: Record<string, string> = {
  backlog: 'bg-muted-foreground/60',
  todo: 'bg-info',
  in_progress: 'bg-primary',
  blocked: 'bg-destructive',
  done: 'bg-success',
}

interface TicketMentionPopoverProps {
  /** The slice of hits to display (already capped to MAX_VISIBLE). */
  hits: TicketSearchHit[]
  /** True while the debounced fetch is in flight. */
  isLoading: boolean
  /** Currently-highlighted index in `hits`. */
  selectedIndex: number
  /** Bottom/left offset (px) anchored on the textarea. The popover is rendered
   *  bottom-aligned so it sits *above* the caret when text wraps near the
   *  bottom of the textarea — same behaviour as the @mention popover. */
  position: { top: number; left: number }
  /** Whether the active project's tickets are the default scope. When false,
   *  the user typed a `slug#` prefix and the popover shows cross-project hits. */
  scopeProjectSlug: string | null
  /** Called when the user clicks an item. */
  onSelect: (hit: TicketSearchHit) => void
  /** Called when the user hovers an item — lets the parent update selectedIndex
   *  so the keyboard cursor follows the mouse. */
  onHover: (index: number) => void
}

/** Max items shown at once. Beyond this the list scrolls internally. */
export const TICKET_MENTION_MAX_VISIBLE = 10

export const TicketMentionPopover = memo(function TicketMentionPopover({
  hits,
  isLoading,
  selectedIndex,
  position,
  scopeProjectSlug,
  onSelect,
  onHover,
}: TicketMentionPopoverProps) {
  const { t } = useTranslation()
  const listRef = useRef<HTMLDivElement>(null)

  // Keep the highlighted row in view as the user navigates with arrow keys.
  useEffect(() => {
    const container = listRef.current
    if (!container) return
    const selected = container.children[selectedIndex] as HTMLElement | undefined
    selected?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Empty state — distinguish "still loading" from "loaded but empty" so the
  // user knows when to keep typing vs. give up.
  if (hits.length === 0) {
    return (
      <div
        className="absolute z-50 w-80 rounded-lg border border-border bg-popover p-2 shadow-lg"
        style={{ bottom: position.top, left: position.left }}
      >
        <p className="text-xs text-muted-foreground px-2 py-1 flex items-center gap-1.5">
          {isLoading ? (
            <>
              <Loader2 className="size-3 animate-spin" />
              {t('chat.ticketMention.loading')}
            </>
          ) : (
            t('chat.ticketMention.noResults')
          )}
        </p>
      </div>
    )
  }

  return (
    <div
      className="absolute z-50 w-80 rounded-lg border border-border bg-popover shadow-lg overflow-hidden"
      style={{ bottom: position.top, left: position.left }}
    >
      {scopeProjectSlug && (
        <div className="px-2.5 py-1 border-b border-border bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('chat.ticketMention.scope', { slug: scopeProjectSlug })}
        </div>
      )}
      <div ref={listRef} className="max-h-64 overflow-y-auto py-1">
        {hits.map((hit, i) => {
          const isDone = hit.status === 'done'
          return (
            <button
              key={hit.id}
              type="button"
              className={cn(
                'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm transition-colors',
                i === selectedIndex
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-muted/50',
                isDone && 'opacity-70',
              )}
              onMouseDown={(e) => {
                // Don't steal focus from the textarea — the parent re-focuses
                // it after inserting the mention.
                e.preventDefault()
                onSelect(hit)
              }}
              onMouseEnter={() => onHover(i)}
            >
              {/* Status dot */}
              <span
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  STATUS_DOT_CLASS[hit.status] ?? 'bg-muted-foreground/60',
                )}
                aria-label={hit.status}
              />

              {/* Ticket number — bold, monospace for alignment */}
              <span className="shrink-0 font-mono font-semibold text-xs tabular-nums">
                #{hit.number}
              </span>

              {/* Title — truncated */}
              <span className={cn('min-w-0 flex-1 truncate', isDone && 'line-through')}>
                {hit.title}
              </span>

              {/* Primary tag chip — only when present */}
              {hit.primaryTag && (
                <span
                  className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium max-w-24 truncate"
                  style={{
                    backgroundColor: `${hit.primaryTag.color}22`,
                    color: hit.primaryTag.color,
                  }}
                  title={hit.primaryTag.label}
                >
                  {hit.primaryTag.label}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
})
