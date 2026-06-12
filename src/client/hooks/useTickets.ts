import { useState, useEffect, useCallback } from 'react'
import { api } from '@/client/lib/api'
import { useSSE, useSSEResync } from '@/client/hooks/useSSE'
import type { TicketSummary, TicketStatus, Ticket, AgentThinkingConfig } from '@/shared/types'

interface CreateTicketInput {
  title: string
  description?: string
  status?: TicketStatus
  tagIds?: string[]
}

interface UpdateTicketInput {
  title?: string
  description?: string
  status?: TicketStatus
  position?: number
  tagIds?: string[]
}

interface StartTicketTaskResult {
  task: {
    id: string
    parentAgentId: string
    ticketId: string
    status: string
    mode: 'await'
    createdAt: number
  }
}

interface EnrichTicketResult {
  task: {
    id: string
    parentAgentId: string
    ticketId: string
    status: string
    mode: 'await'
    kind: 'enrich'
    createdAt: number
  }
}

export function useTickets(projectId: string | null) {
  const [tickets, setTickets] = useState<TicketSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const refetch = useCallback(async () => {
    if (!projectId) {
      setTickets([])
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    try {
      const data = await api.get<{ tickets: TicketSummary[]; hasMore: boolean }>(
        `/projects/${projectId}/tickets`,
      )
      setTickets(data.tickets)
    } catch {
      setTickets([])
    } finally {
      setIsLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    refetch()
  }, [refetch])

  useSSE({
    'ticket:created': (data) => {
      const ticket = data.ticket as TicketSummary
      if (ticket.projectId !== projectId) return
      setTickets((prev) => {
        if (prev.some((t) => t.id === ticket.id)) return prev
        return [...prev, ticket]
      })
    },
    'ticket:updated': (data) => {
      const ticket = data.ticket as TicketSummary
      if (ticket.projectId !== projectId) return
      setTickets((prev) => prev.map((t) => (t.id === ticket.id ? ticket : t)))
    },
    'ticket:deleted': (data) => {
      const { ticketId, projectId: pid } = data as { ticketId: string; projectId: string }
      if (pid !== projectId) return
      setTickets((prev) => prev.filter((t) => t.id !== ticketId))
    },
    // Task lifecycle bumps running counts — refresh affected tickets lazily
    'task:status': () => {
      // Cheap: re-fetch the whole list. Optimization possible later if needed.
      refetch().catch(() => undefined)
    },
    'task:done': () => {
      refetch().catch(() => undefined)
    },
  })

  useSSEResync(refetch)

  const createTicket = useCallback(
    async (input: CreateTicketInput): Promise<TicketSummary | null> => {
      if (!projectId) return null
      const data = await api.post<{ ticket: TicketSummary }>(
        `/projects/${projectId}/tickets`,
        input,
      )
      return data.ticket
    },
    [projectId],
  )

  const updateTicket = useCallback(
    async (ticketId: string, input: UpdateTicketInput) => {
      const data = await api.patch<{ ticket: TicketSummary }>(`/tickets/${ticketId}`, input)
      return data.ticket
    },
    [],
  )

  const deleteTicket = useCallback(async (ticketId: string) => {
    await api.delete(`/tickets/${ticketId}`)
  }, [])

  const startTicketTask = useCallback(
    async (
      ticketId: string,
      agentId: string,
      runPrompt?: string,
      toolboxIds?: string[],
      /** Per-run model override. Coupled with `providerId` (both or neither).
       *  When unset, the server falls back to project default → Agent model. */
      model?: string,
      providerId?: string,
      /** Per-run thinking/effort override. When unset, inherits project → Agent. */
      thinkingConfig?: AgentThinkingConfig,
    ): Promise<StartTicketTaskResult['task']> => {
      const trimmed = runPrompt?.trim() ?? ''
      const body: {
        agentId: string
        runPrompt?: string
        toolboxIds?: string[]
        model?: string
        providerId?: string
        thinkingConfig?: AgentThinkingConfig
      } = { agentId }
      if (trimmed.length > 0) body.runPrompt = trimmed
      if (toolboxIds && toolboxIds.length > 0) body.toolboxIds = toolboxIds
      if (model && providerId) {
        body.model = model
        body.providerId = providerId
      }
      if (thinkingConfig) body.thinkingConfig = thinkingConfig
      const data = await api.post<StartTicketTaskResult>(
        `/tickets/${ticketId}/start-task`,
        body,
      )
      return data.task
    },
    [],
  )

  const enrichTicket = useCallback(
    async (
      ticketId: string,
      agentId: string,
      focus?: string,
    ): Promise<EnrichTicketResult['task']> => {
      const data = await api.post<EnrichTicketResult>(`/tickets/${ticketId}/enrich`, { agentId, focus })
      return data.task
    },
    [],
  )

  return {
    tickets,
    isLoading,
    refetch,
    createTicket,
    updateTicket,
    deleteTicket,
    startTicketTask,
    enrichTicket,
  }
}

export function useTicket(ticketId: string | null) {
  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const refetch = useCallback(async () => {
    if (!ticketId) {
      setTicket(null)
      return
    }
    setIsLoading(true)
    try {
      const data = await api.get<{ ticket: Ticket }>(`/tickets/${ticketId}`)
      setTicket(data.ticket)
    } catch {
      setTicket(null)
    } finally {
      setIsLoading(false)
    }
  }, [ticketId])

  useEffect(() => {
    refetch()
  }, [refetch])

  useSSE({
    'ticket:updated': (data) => {
      const updated = data.ticket as { id: string }
      if (updated.id === ticketId) refetch()
    },
    'ticket:deleted': (data) => {
      if (data.ticketId === ticketId) setTicket(null)
    },
    'task:status': () => {
      refetch().catch(() => undefined)
    },
    'task:done': () => {
      refetch().catch(() => undefined)
    },
  })

  useSSEResync(refetch)

  return { ticket, isLoading, refetch }
}
