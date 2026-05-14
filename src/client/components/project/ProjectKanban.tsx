import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { TicketColumn } from './TicketColumn'
import { TicketCard } from './TicketCard'
import { useTickets } from '@/client/hooks/useTickets'
import { TICKET_STATUSES } from '@/shared/constants'
import { Button } from '@/client/components/ui/button'
import { Plus } from 'lucide-react'
import { useSidePanel } from '@/client/contexts/SidePanelContext'
import type { TicketStatus, TicketSummary } from '@/shared/types'

interface ProjectKanbanProps {
  projectId: string
  onNewTicket: () => void
}

export function ProjectKanban({ projectId, onNewTicket }: ProjectKanbanProps) {
  const { t } = useTranslation()
  const { tickets, updateTicket } = useTickets(projectId)
  const { openTicket } = useSidePanel()

  const [activeTicket, setActiveTicket] = useState<TicketSummary | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  )

  // Group tickets by status, sorted by position
  const byStatus = useMemo(() => {
    const map: Record<TicketStatus, TicketSummary[]> = {
      backlog: [],
      todo: [],
      in_progress: [],
      blocked: [],
      done: [],
    }
    for (const ticket of tickets) {
      const s = ticket.status as TicketStatus
      if (map[s]) map[s].push(ticket)
    }
    for (const status of TICKET_STATUSES) {
      map[status].sort((a, b) => a.position - b.position)
    }
    return map
  }, [tickets])

  function handleDragStart(event: DragStartEvent) {
    const ticketId = event.active.id as string
    const ticket = tickets.find((t) => t.id === ticketId)
    if (ticket) setActiveTicket(ticket)
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveTicket(null)
    const { active, over } = event
    if (!over) return

    const sourceTicket = tickets.find((t) => t.id === active.id)
    if (!sourceTicket) return

    // Resolve target column from `over` (either another ticket card or a column droppable)
    let targetStatus: TicketStatus | null = null
    let overTicket: TicketSummary | null = null
    if (typeof over.id === 'string' && over.id.startsWith('column:')) {
      targetStatus = over.id.slice('column:'.length) as TicketStatus
    } else {
      overTicket = tickets.find((t) => t.id === over.id) ?? null
      if (overTicket) targetStatus = overTicket.status as TicketStatus
    }

    if (!targetStatus) return

    if (sourceTicket.status === targetStatus && overTicket && overTicket.id !== sourceTicket.id) {
      // Reorder within the same column — compute a position between neighbors of overTicket
      const columnTickets = byStatus[targetStatus]
      const overIdx = columnTickets.findIndex((t) => t.id === overTicket.id)
      const sourceIdx = columnTickets.findIndex((t) => t.id === sourceTicket.id)
      if (overIdx === -1 || sourceIdx === -1) return

      const movingDown = sourceIdx < overIdx
      // When moving down, place after overTicket ; when moving up, before
      const anchor = movingDown ? overIdx : overIdx - 1
      const next = movingDown ? overIdx + 1 : overIdx

      const prevPos = columnTickets[anchor]?.position
      const nextPos = columnTickets[next]?.position
      let newPosition: number
      if (prevPos === undefined) newPosition = (nextPos ?? 1024) - 512
      else if (nextPos === undefined) newPosition = prevPos + 1024
      else newPosition = Math.floor((prevPos + nextPos) / 2)

      updateTicket(sourceTicket.id, { position: newPosition }).catch(() => undefined)
      return
    }

    if (sourceTicket.status !== targetStatus) {
      // Cross-column move — server places at top of target column (max + step)
      updateTicket(sourceTicket.id, { status: targetStatus }).catch(() => undefined)
    }
  }

  function handleTicketClick(ticket: TicketSummary) {
    openTicket({ ticketId: ticket.id })
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-end border-b border-border px-4 py-2">
        <Button size="sm" onClick={onNewTicket}>
          <Plus className="mr-1 size-4" />
          {t('projects.kanban.newTicket')}
        </Button>
      </header>
      <div className="flex-1 overflow-x-auto p-4">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="flex h-full gap-3">
            {TICKET_STATUSES.map((status) => (
              <TicketColumn
                key={status}
                status={status}
                label={t(`projects.status.${status}`)}
                tickets={byStatus[status]}
                onTicketClick={handleTicketClick}
              />
            ))}
          </div>
          <DragOverlay>
            {activeTicket ? <TicketCard ticket={activeTicket} isOverlay /> : null}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  )
}
