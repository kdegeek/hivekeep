import { Hono } from 'hono'
import {
  getTicket,
  updateTicket,
  deleteTicket,
  startTicketTask,
} from '@/server/services/tickets'
import type { AppVariables } from '@/server/app'
import { createLogger } from '@/server/logger'
import { TICKET_STATUSES } from '@/shared/constants'
import type { TicketStatus } from '@/shared/types'

const log = createLogger('routes:tickets')

export const ticketRoutes = new Hono<{ Variables: AppVariables }>()

ticketRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const ticket = await getTicket(id)
  if (!ticket) {
    return c.json({ error: { code: 'TICKET_NOT_FOUND', message: 'Ticket not found' } }, 404)
  }
  return c.json({ ticket })
})

ticketRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))

  const update: {
    title?: string
    description?: string
    status?: TicketStatus
    position?: number
    tagIds?: string[]
  } = {}
  if (typeof body.title === 'string') update.title = body.title
  if (typeof body.description === 'string') update.description = body.description
  if (typeof body.status === 'string' && (TICKET_STATUSES as readonly string[]).includes(body.status)) {
    update.status = body.status as TicketStatus
  }
  if (typeof body.position === 'number' && Number.isFinite(body.position)) update.position = body.position
  if (Array.isArray(body.tagIds)) {
    update.tagIds = body.tagIds.filter((t: unknown): t is string => typeof t === 'string')
  }

  try {
    const ticket = await updateTicket(id, update)
    if (!ticket) {
      return c.json({ error: { code: 'TICKET_NOT_FOUND', message: 'Ticket not found' } }, 404)
    }
    return c.json({ ticket })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    log.warn({ err }, 'updateTicket failed')
    return c.json({ error: { code: 'INTERNAL', message: msg } }, 500)
  }
})

ticketRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const ok = await deleteTicket(id)
  if (!ok) {
    return c.json({ error: { code: 'TICKET_NOT_FOUND', message: 'Ticket not found' } }, 404)
  }
  return c.json({ success: true })
})

ticketRoutes.post('/:id/start-task', async (c) => {
  const ticketId = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const kinId = typeof body.kinId === 'string' ? body.kinId.trim() : ''
  if (!kinId) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'kinId is required' } }, 400)
  }

  try {
    const task = await startTicketTask(ticketId, kinId)
    return c.json({ task }, 201)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg === 'TICKET_NOT_FOUND') {
      return c.json({ error: { code: 'TICKET_NOT_FOUND', message: 'Ticket not found' } }, 404)
    }
    if (msg === 'KIN_NOT_FOUND') {
      return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
    }
    log.warn({ err }, 'startTicketTask failed')
    return c.json({ error: { code: 'INTERNAL', message: msg } }, 500)
  }
})
