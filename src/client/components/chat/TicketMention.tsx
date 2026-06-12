/**
 * Inline ticket reference renderer.
 *
 * Replaces a `#42` or `hivekeep#42` token in a markdown message with a small
 * clickable badge that:
 *
 *   - shows the original ref text the author typed (no auto-qualification),
 *   - displays the ticket title in a tooltip,
 *   - shows a colored status dot,
 *   - opens the existing side-panel ticket modal on click.
 *
 * Resolution is delegated to `useTicketMention`, which batches lookups via the
 * `TicketMentionProvider`. While the ref is pending, we render the raw text
 * verbatim; if resolution fails the raw text stays — no broken-link UX.
 */
import { useTicketMention } from '@/client/contexts/TicketMentionContext'
import { useSidePanel } from '@/client/contexts/SidePanelContext'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/client/components/ui/tooltip'
import { cn } from '@/client/lib/utils'
import type { TicketStatus } from '@/shared/types'

interface TicketMentionProps {
  /** The exact string the author wrote (e.g. `#42` or `hivekeep#42`). Used as the
   *  cache key and the rendered label. */
  raw: string
}

/** Status → tailwind classes for the dot + the badge background.
 *  Matches the design tokens used elsewhere (TicketColumn). */
const STATUS_STYLE: Record<TicketStatus, { dot: string; ring: string }> = {
  backlog: { dot: 'bg-muted-foreground/60', ring: 'ring-muted-foreground/30' },
  todo: { dot: 'bg-info', ring: 'ring-info/30' },
  in_progress: { dot: 'bg-primary', ring: 'ring-primary/30' },
  blocked: { dot: 'bg-destructive', ring: 'ring-destructive/30' },
  done: { dot: 'bg-success', ring: 'ring-success/30' },
}

export function TicketMention({ raw }: TicketMentionProps) {
  const state = useTicketMention(raw)
  const { openTicket } = useSidePanel()

  // Pending or unresolved: render the literal text, exactly as authored. This
  // keeps the message readable while we wait (and forever, if the ref is bad).
  if (state.state !== 'resolved') {
    return <span className="whitespace-nowrap">{raw}</span>
  }

  const { data } = state
  const style = STATUS_STYLE[data.status]

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    openTicket({ ticketId: data.id })
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleClick}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border border-border/60',
            'bg-muted/40 px-1.5 py-0 align-baseline text-[0.85em] font-medium',
            'text-foreground/80 leading-tight whitespace-nowrap',
            'transition-colors hover:bg-muted hover:text-foreground',
            'cursor-pointer ring-1 ring-transparent hover:ring-1',
            style.ring,
          )}
          aria-label={`Ticket ${raw}: ${data.title}`}
        >
          <span
            className={cn('inline-block size-1.5 rounded-full', style.dot)}
            aria-hidden="true"
          />
          <span className="font-mono">{raw}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{data.title}</span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {data.projectName} · {data.status.replace('_', ' ')}
          </span>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
