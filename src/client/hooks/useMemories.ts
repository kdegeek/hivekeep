import { useState, useEffect, useCallback } from 'react'
import { api } from '@/client/lib/api'
import { useSSE, useSSEResync } from '@/client/hooks/useSSE'
import type { MemorySummary, MemoryCategory, MemoryScope } from '@/shared/types'

const PAGE_SIZE = 50

interface MemoriesResponse {
  memories: MemorySummary[]
  total: number
  hasMore: boolean
}

interface MemoryFilters {
  category?: MemoryCategory
  agentId?: string
  scope?: MemoryScope
}

interface CreateMemoryData {
  content: string
  category: MemoryCategory
  subject?: string
  scope?: MemoryScope
}

interface UpdateMemoryData {
  content?: string
  category?: MemoryCategory
  subject?: string | null
  scope?: MemoryScope
}

export function useMemories(agentId?: string | null) {
  const [memories, setMemories] = useState<MemorySummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [filters, setFilters] = useState<MemoryFilters>({})
  const [page, setPage] = useState(0)
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)

  const fetchMemories = useCallback(async (currentFilters?: MemoryFilters) => {
    setIsLoading(true)
    try {
      const f = currentFilters ?? filters
      const params = new URLSearchParams()
      if (f.category) params.set('category', f.category)
      if (f.scope) params.set('scope', f.scope)
      params.set('limit', String(PAGE_SIZE))
      params.set('offset', String(page * PAGE_SIZE))

      if (agentId) {
        const qs = params.toString() ? `?${params.toString()}` : ''
        const data = await api.get<MemoriesResponse>(`/agents/${agentId}/memories${qs}`)
        setMemories(data.memories.map((m) => ({ ...m, agentId })))
        setTotal(data.total)
        setHasMore(data.hasMore)
      } else {
        if (f.agentId) params.set('agentId', f.agentId)
        const qs = params.toString() ? `?${params.toString()}` : ''
        const data = await api.get<MemoriesResponse>(`/memories${qs}`)
        setMemories(data.memories)
        setTotal(data.total)
        setHasMore(data.hasMore)
      }
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false)
    }
  }, [agentId, filters, page])

  useEffect(() => {
    fetchMemories()
  }, [fetchMemories])

  const createMemory = useCallback(async (targetAgentId: string, data: CreateMemoryData) => {
    const result = await api.post<{ memory: MemorySummary }>(`/agents/${targetAgentId}/memories`, data)
    setMemories((prev) => [{ ...result.memory, agentId: targetAgentId }, ...prev])
    setTotal((prev) => prev + 1)
    return result.memory
  }, [])

  const updateMemory = useCallback(async (memoryId: string, targetAgentId: string, updates: UpdateMemoryData) => {
    const result = await api.patch<{ memory: MemorySummary }>(`/agents/${targetAgentId}/memories/${memoryId}`, updates)
    setMemories((prev) => prev.map((m) => (m.id === memoryId ? { ...result.memory, agentId: targetAgentId } : m)))
    return result.memory
  }, [])

  const deleteMemory = useCallback(async (memoryId: string, targetAgentId: string) => {
    await api.delete(`/agents/${targetAgentId}/memories/${memoryId}`)
    setMemories((prev) => prev.filter((m) => m.id !== memoryId))
    setTotal((prev) => Math.max(prev - 1, 0))
  }, [])

  const applyFilters = useCallback((newFilters: MemoryFilters) => {
    setFilters(newFilters)
    setPage(0)
  }, [])

  // Refetch on reconnect/resume — SSE does not replay missed events
  useSSEResync(() => { fetchMemories() })

  // SSE: real-time memory updates
  useSSE({
    'memory:created': (data) => {
      const memAgentId = data.agentId as string
      if (agentId && memAgentId !== agentId) return
      fetchMemories()
    },
    'memory:updated': (data) => {
      const memAgentId = data.agentId as string
      if (agentId && memAgentId !== agentId) return
      fetchMemories()
    },
    'memory:deleted': (data) => {
      const memoryId = data.memoryId as string
      const memAgentId = data.agentId as string
      if (agentId && memAgentId !== agentId) return
      setMemories((prev) => prev.filter((m) => m.id !== memoryId))
      setTotal((prev) => Math.max(prev - 1, 0))
    },
  })

  return {
    memories,
    isLoading,
    filters,
    page,
    setPage,
    total,
    hasMore,
    pageSize: PAGE_SIZE,
    applyFilters,
    createMemory,
    updateMemory,
    deleteMemory,
    refetch: fetchMemories,
  }
}
