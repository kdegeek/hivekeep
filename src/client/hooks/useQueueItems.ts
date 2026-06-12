import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/client/lib/api'
import { useSSE, useSSEResync } from '@/client/hooks/useSSE'

export interface QueueItem {
  id: string
  agentId: string
  messageType: string
  content: string
  sourceType: string
  sourceId: string | null
  priority: number
  createdAt: string
}

export function useQueueItems(agentId: string | null) {
  const [items, setItems] = useState<QueueItem[]>([])
  const [isRemoving, setIsRemoving] = useState<string | null>(null)
  const currentAgentIdRef = useRef(agentId)
  currentAgentIdRef.current = agentId

  const fetchItems = useCallback(async () => {
    if (!agentId) {
      setItems([])
      return
    }
    try {
      const data = await api.get<{ items: QueueItem[] }>(`/agents/${agentId}/messages/queue`)
      // Only update if we're still on the same agent
      if (currentAgentIdRef.current === agentId) {
        setItems(data.items)
      }
    } catch {
      // Non-fatal
    }
  }, [agentId])

  useEffect(() => {
    fetchItems()
    setItems([])
  }, [fetchItems])

  // Refetch when queue state changes
  useSSE({
    'queue:update': (data) => {
      if (data.agentId !== agentId) return
      fetchItems()
    },
  })

  // Catch up on resume (locked phone / backgrounded tab) — queue:update events
  // missed while asleep are not replayed.
  useSSEResync(fetchItems)

  const removeItem = useCallback(async (itemId: string) => {
    if (!agentId) return
    setIsRemoving(itemId)
    try {
      await api.delete(`/agents/${agentId}/messages/queue/${itemId}`)
      // Optimistic removal — SSE will also trigger a refetch
      setItems((prev) => prev.filter((i) => i.id !== itemId))
    } catch {
      // Will be corrected by next SSE-triggered refetch
    } finally {
      setIsRemoving(null)
    }
  }, [agentId])

  const injectItem = useCallback(async (itemId: string) => {
    if (!agentId) return
    const item = items.find((i) => i.id === itemId)
    if (!item) return
    setIsRemoving(itemId)
    try {
      await api.post(`/agents/${agentId}/messages/inject`, {
        content: item.content,
        queueItemId: itemId,
      })
      setItems((prev) => prev.filter((i) => i.id !== itemId))
    } catch {
      // Will be corrected by next SSE-triggered refetch
    } finally {
      setIsRemoving(null)
    }
  }, [agentId, items])

  return { items, removeItem, injectItem, isRemoving }
}
