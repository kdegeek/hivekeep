import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  pointerWithin,
  rectIntersection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type CollisionDetection,
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

/**
 * Drag-drop strategy:
 *  - We keep a LOCAL copy of the tickets (`displayTickets`) that mirrors the
 *    hook's `tickets` (server-truth) but can be optimistically reordered during
 *    a drag.
 *  - `onDragOver` moves the dragged item across columns instantly as the cursor
 *    enters them, so the user sees the ticket follow the cursor instead of
 *    snapping back on drop.
 *  - `onDragEnd` persists the final position+status via a single API call. The
 *    SSE round-trip then reconciles `tickets` → `displayTickets` via useEffect.
 *
 * Collision detection prefers `pointerWithin` (only triggers when the pointer
 * is actually inside a droppable rect). Falls back to `rectIntersection` to
 * avoid losing the drop target near column edges.
 */
export function ProjectKanban({ projectId, onNewTicket }: ProjectKanbanProps) {
  const { t } = useTranslation()
  const { tickets, updateTicket } = useTickets(projectId)
  const { openTicket } = useSidePanel()

  const [displayTickets, setDisplayTickets] = useState<TicketSummary[]>(tickets)
  const [activeTicket, setActiveTicket] = useState<TicketSummary | null>(null)

  // Sync local state with server truth whenever the upstream list changes
  // (SSE events, refetch, etc.). During a drag this is fine — useTickets debounces
  // events lightly and our optimistic update converges on the same final state.
  useEffect(() => {
    setDisplayTickets(tickets)
  }, [tickets])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  )

  const collisionDetectionStrategy: CollisionDetection = (args) => {
    const pointerHits = pointerWithin(args)
    if (pointerHits.length > 0) return pointerHits
    return rectIntersection(args)
  }

  // Group tickets by status, sorted by position (rebuilds on every drag tick — keep cheap)
  const byStatus = useMemo(() => {
    const map: Record<TicketStatus, TicketSummary[]> = {
      backlog: [],
      todo: [],
      in_progress: [],
      blocked: [],
      done: [],
    }
    for (const ticket of displayTickets) {
      const s = ticket.status as TicketStatus
      if (map[s]) map[s].push(ticket)
    }
    for (const status of TICKET_STATUSES) {
      map[status].sort((a, b) => a.position - b.position)
    }
    return map
  }, [displayTickets])

  function resolveTargetStatus(overId: string | number): TicketStatus | null {
    if (typeof overId === 'string' && overId.startsWith('column:')) {
      return overId.slice('column:'.length) as TicketStatus
    }
    const overTicket = displayTickets.find((t) => t.id === overId)
    return overTicket ? (overTicket.status as TicketStatus) : null
  }

  function handleDragStart(event: DragStartEvent) {
    const ticketId = event.active.id as string
    const ticket = displayTickets.find((t) => t.id === ticketId)
    if (ticket) setActiveTicket(ticket)
  }

  /** Move the dragged ticket between columns optimistically, so the user sees
   *  it follow during the drag (no snap-back on drop). Reordering within the
   *  same column is also reflected immediately. */
  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event
    if (!over) return

    const source = displayTickets.find((t) => t.id === active.id)
    if (!source) return

    const targetStatus = resolveTargetStatus(over.id)
    if (!targetStatus) return

    const overIsTicket = typeof over.id === 'string' && !over.id.startsWith('column:')

    if (source.status !== targetStatus) {
      // Cross-column move during drag — drop the ticket at the spot of the hovered
      // ticket (or end of column if hovering the empty area).
      setDisplayTickets((prev) => {
        const targetList = prev.filter((t) => t.status === targetStatus && t.id !== source.id)
        let insertIndex = targetList.length
        if (overIsTicket) {
          const idx = targetList.findIndex((t) => t.id === over.id)
          if (idx >= 0) insertIndex = idx
        }
        // Re-sequence positions inside the target list with the source inserted
        const nextTargetList = [...targetList]
        nextTargetList.splice(insertIndex, 0, { ...source, status: targetStatus })
        const repositioned = nextTargetList.map((t, i) => ({ ...t, position: (i + 1) * 1024 }))
        // Replace target-column items in the global list, keep others as-is
        return prev
          .filter((t) => t.status !== targetStatus && t.id !== source.id)
          .concat(repositioned)
      })
    } else if (overIsTicket && over.id !== source.id) {
      // Same-column reorder during drag
      setDisplayTickets((prev) => {
        const columnTickets = prev
          .filter((t) => t.status === targetStatus)
          .sort((a, b) => a.position - b.position)
        const fromIdx = columnTickets.findIndex((t) => t.id === source.id)
        const toIdx = columnTickets.findIndex((t) => t.id === over.id)
        if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return prev
        const reordered = [...columnTickets]
        const [moved] = reordered.splice(fromIdx, 1)
        if (!moved) return prev
        reordered.splice(toIdx, 0, moved)
        const repositioned = reordered.map((t, i) => ({ ...t, position: (i + 1) * 1024 }))
        return prev.filter((t) => t.status !== targetStatus).concat(repositioned)
      })
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveTicket(null)
    const { active, over } = event
    if (!over) {
      // Drag cancelled outside a droppable — revert local state to server truth
      setDisplayTickets(tickets)
      return
    }

    // displayTickets already reflects the desired final state thanks to onDragOver.
    // Persist whatever changed for this ticket vs. the server-truth `tickets`.
    const optimistic = displayTickets.find((t) => t.id === active.id)
    const original = tickets.find((t) => t.id === active.id)
    if (!optimistic || !original) return

    const statusChanged = optimistic.status !== original.status
    const positionChanged = optimistic.position !== original.position
    if (!statusChanged && !positionChanged) return

    updateTicket(active.id as string, {
      status: statusChanged ? (optimistic.status as TicketStatus) : undefined,
      position: optimistic.position,
    }).catch(() => {
      // Revert to server truth on failure (SSE may also do it)
      setDisplayTickets(tickets)
    })
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
          collisionDetection={collisionDetectionStrategy}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
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
