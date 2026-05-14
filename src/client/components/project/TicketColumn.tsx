import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { TicketCard } from './TicketCard'
import { cn } from '@/client/lib/utils'
import type { TicketStatus, TicketSummary } from '@/shared/types'

interface TicketColumnProps {
  status: TicketStatus
  label: string
  tickets: TicketSummary[]
  onTicketClick: (ticket: TicketSummary) => void
}

export function TicketColumn({ status, label, tickets, onTicketClick }: TicketColumnProps) {
  // Column-level droppable so empty columns still accept drops
  const { setNodeRef, isOver } = useDroppable({
    id: `column:${status}`,
    data: { type: 'column', status },
  })

  return (
    <div className="flex h-full w-72 shrink-0 flex-col">
      <header className="mb-2 flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </h2>
        <span className="text-xs text-muted-foreground">{tickets.length}</span>
      </header>
      <div
        ref={setNodeRef}
        className={cn(
          'flex-1 space-y-2 overflow-y-auto rounded-lg border-2 border-dashed border-transparent p-1 transition-colors',
          isOver && 'border-primary/40 bg-primary/5',
        )}
      >
        <SortableContext items={tickets.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tickets.map((ticket) => (
            <TicketCard
              key={ticket.id}
              ticket={ticket}
              onClick={() => onTicketClick(ticket)}
            />
          ))}
        </SortableContext>
        {tickets.length === 0 && (
          <p className="px-2 pt-4 text-center text-xs text-muted-foreground/60">
            No tickets
          </p>
        )}
      </div>
    </div>
  )
}
