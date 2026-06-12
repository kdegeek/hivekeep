import { useCallback, useEffect, useRef, useState } from 'react'
import { useSSE, useSSEResync } from '@/client/hooks/useSSE'
import { api } from '@/client/lib/api'

/**
 * Track unread assistant message counts per agent.
 *
 * Persistence model:
 *  - Initial counts are fetched from the server on mount (`GET /api/me/unread-counts`),
 *    so a page reload or fresh device sees state that survived the previous session.
 *  - SSE `chat:message` increments the in-memory counter for non-active Agents,
 *    keeping the badge live without a server roundtrip per message.
 *  - Whenever the user opens an Agent (sidebar click OR URL navigation), or a message
 *    arrives in the active Agent, the server-side `lastReadAt` is bumped via
 *    `POST /api/agents/:id/mark-read`, keeping persistence in sync with the UI.
 */
export function useUnreadPerAgent(selectedAgentId: string | null): {
  unreadCounts: Map<string, number>
  clearUnread: (agentId: string) => void
} {
  const [unreadCounts, setUnreadCounts] = useState<Map<string, number>>(new Map())
  const selectedRef = useRef(selectedAgentId)
  selectedRef.current = selectedAgentId

  // Hydrate from server on mount. Skip the currently-selected Agent (the user is
  // actively viewing it, so it's de facto read) and bump its server marker.
  useEffect(() => {
    api
      .get<{ counts: Record<string, number> }>('/me/unread-counts')
      .then(({ counts }) => {
        const next = new Map(Object.entries(counts))
        if (selectedRef.current) next.delete(selectedRef.current)
        setUnreadCounts(next)
        if (selectedRef.current && counts[selectedRef.current]) {
          api.post(`/agents/${selectedRef.current}/mark-read`).catch(() => { /* silent */ })
        }
      })
      .catch(() => { /* fall back to empty map — SSE will hydrate as new messages arrive */ })
  }, [])

  // When the user lands on or switches to an Agent (including via URL navigation
  // that bypasses handleSelectAgent), clear its badge and persist the read marker.
  useEffect(() => {
    if (!selectedAgentId) return
    setUnreadCounts((prev) => {
      if (!prev.has(selectedAgentId)) return prev
      const next = new Map(prev)
      next.delete(selectedAgentId)
      return next
    })
    api.post(`/agents/${selectedAgentId}/mark-read`).catch(() => { /* silent */ })
  }, [selectedAgentId])

  const handleMessage = useCallback(
    (data: Record<string, unknown>) => {
      const agentId = data.agentId as string | undefined
      if (!agentId) return
      // Skip task and quick session messages
      if (data.taskId || data.sessionId) return
      // Only count assistant messages
      if (data.role !== 'assistant') return

      // Active Agent: bump server marker so persistence stays in sync, no badge increment
      if (agentId === selectedRef.current) {
        api.post(`/agents/${agentId}/mark-read`).catch(() => { /* silent */ })
        return
      }

      setUnreadCounts((prev) => {
        const next = new Map(prev)
        next.set(agentId, (next.get(agentId) ?? 0) + 1)
        return next
      })
    },
    [],
  )

  useSSE({
    'chat:message': handleMessage,
    'agent:read': (data) => {
      const agentId = data.agentId as string | undefined
      if (!agentId) return
      setUnreadCounts((prev) => {
        if (!prev.has(agentId)) return prev
        const next = new Map(prev)
        next.delete(agentId)
        return next
      })
    },
  })

  const fetchUnreadCounts = useCallback(() => {
    api
      .get<{ counts: Record<string, number> }>('/me/unread-counts')
      .then(({ counts }) => {
        const next = new Map(Object.entries(counts))
        if (selectedRef.current) next.delete(selectedRef.current)
        setUnreadCounts(next)
      })
      .catch(() => { /* silent */ })
  }, [])

  useSSEResync(fetchUnreadCounts)

  const clearUnread = useCallback((agentId: string) => {
    setUnreadCounts((prev) => {
      if (!prev.has(agentId) || prev.get(agentId) === 0) return prev
      const next = new Map(prev)
      next.delete(agentId)
      return next
    })
    // Persist server-side: any subsequent reload will see 0 unread for this Agent
    api.post(`/agents/${agentId}/mark-read`).catch(() => { /* silent — local state already cleared */ })
  }, [])

  return { unreadCounts, clearUnread }
}
