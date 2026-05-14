import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Badge } from '@/client/components/ui/badge'
import { Loader2, Play, ListChecks } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import type { TicketSummary } from '@/shared/types'

interface TicketCardProps {
  ticket: TicketSummary
  onClick?: () => void
  isOverlay?: boolean
}

export function TicketCard({ ticket, onClick, isOverlay = false }: TicketCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: ticket.id,
    data: { type: 'ticket', ticket },
  })

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  }

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={cn(
        'group relative cursor-grab rounded-lg border border-border bg-card p-3 shadow-sm transition-shadow active:cursor-grabbing',
        isDragging && !isOverlay && 'opacity-30',
        isOverlay && 'shadow-lg',
      )}
      {...attributes}
      {...listeners}
    >
      <button
        type="button"
        // Use pointer-up on a tiny click instead of full click, so drag doesn't trigger
        onClick={(e) => {
          // dnd-kit blocks click while dragging; this still fires for short clicks
          e.stopPropagation()
          onClick?.()
        }}
        className="block w-full text-left"
      >
        <h3 className="line-clamp-2 text-sm font-medium leading-snug">{ticket.title}</h3>

        {ticket.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {ticket.tags.slice(0, 4).map((tag) => (
              <Badge
                key={tag.id}
                variant="secondary"
                className="px-1.5 py-0 text-[10px] font-normal"
                style={{
                  backgroundColor: `${tag.color}20`,
                  color: tag.color,
                  borderColor: `${tag.color}40`,
                }}
              >
                {tag.label}
              </Badge>
            ))}
            {ticket.tags.length > 4 && (
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
                +{ticket.tags.length - 4}
              </Badge>
            )}
          </div>
        )}

        {(ticket.taskCount > 0 || ticket.runningTaskCount > 0) && (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            {ticket.runningTaskCount > 0 ? (
              <span className="inline-flex items-center gap-1 text-primary">
                <Loader2 className="size-3 animate-spin" />
                {ticket.runningTaskCount} running
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <ListChecks className="size-3" />
                {ticket.taskCount} task{ticket.taskCount > 1 ? 's' : ''}
              </span>
            )}
          </div>
        )}
      </button>
    </article>
  )
}
