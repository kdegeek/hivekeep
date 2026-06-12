import { useState, useEffect, useCallback } from 'react'
import { api } from '@/client/lib/api'
import { useSSE, useSSEResync } from '@/client/hooks/useSSE'
import type { Toolbox } from '@/shared/types'

interface ToolboxesResponse {
  toolboxes: Toolbox[]
}

interface ToolboxResponse {
  toolbox: Toolbox
}

export interface CreateToolboxInput {
  name: string
  description?: string | null
  toolNames: string[]
}

export type UpdateToolboxInput = Partial<CreateToolboxInput>

/**
 * CRUD over the global, user-defined (and built-in) toolboxes
 * (GET/POST/PUT/DELETE /api/toolboxes). Mirrors useAgents/useCrons: keeps a local
 * list, mutates optimistically through the API, and returns the helpers the
 * management page and task-creation multi-select consume. Built-in toolboxes
 * (builtin=true) are returned by the list but reject edit/delete server-side.
 */
export function useToolboxes() {
  const [toolboxes, setToolboxes] = useState<Toolbox[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const refetch = useCallback(async () => {
    try {
      const data = await api.get<ToolboxesResponse>('/toolboxes')
      setToolboxes(data.toolboxes)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    refetch()
  }, [refetch])

  useSSE({
    'toolbox:created': (data) => {
      const toolbox = data as unknown as Toolbox
      setToolboxes((prev) => {
        if (prev.some((tb) => tb.id === toolbox.id)) return prev
        return [...prev, toolbox]
      })
    },
    'toolbox:updated': (data) => {
      const toolbox = data as unknown as Toolbox
      setToolboxes((prev) => prev.map((tb) => (tb.id === toolbox.id ? toolbox : tb)))
    },
    'toolbox:deleted': (data) => {
      const id = data.toolboxId as string
      setToolboxes((prev) => prev.filter((tb) => tb.id !== id))
    },
  })

  useSSEResync(refetch)

  const createToolbox = useCallback(async (input: CreateToolboxInput) => {
    const { toolbox } = await api.post<ToolboxResponse>('/toolboxes', input)
    setToolboxes((prev) => [...prev, toolbox])
    return toolbox
  }, [])

  const updateToolbox = useCallback(async (id: string, input: UpdateToolboxInput) => {
    const { toolbox } = await api.patch<ToolboxResponse>(`/toolboxes/${id}`, input)
    setToolboxes((prev) => prev.map((tb) => (tb.id === id ? toolbox : tb)))
    return toolbox
  }, [])

  const deleteToolbox = useCallback(async (id: string) => {
    await api.delete(`/toolboxes/${id}`)
    setToolboxes((prev) => prev.filter((tb) => tb.id !== id))
  }, [])

  return {
    toolboxes,
    isLoading,
    refetch,
    createToolbox,
    updateToolbox,
    deleteToolbox,
  }
}
