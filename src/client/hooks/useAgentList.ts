import { useState, useEffect, useCallback } from 'react'
import { api } from '@/client/lib/api'
import { useSSE } from '@/client/hooks/useSSE'

export interface AgentListItem {
  id: string
  slug?: string
  name: string
  role?: string
  avatarUrl: string | null
  activeProjectId?: string | null
}

/**
 * Lightweight hook to fetch the agent list for selectors and display.
 * Unlike the full `useAgents` hook, this doesn't include ordering, CRUD, or models.
 * Use this in settings pages that just need an agent list for dropdowns or name/avatar display.
 *
 * Listens to `agent:active-project` so consumers (e.g. project avatars stack) reflect
 * project-activation changes live.
 */
export function useAgentList() {
  const [agents, setAgents] = useState<AgentListItem[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const fetchAgents = useCallback(async () => {
    try {
      const data = await api.get<{ agents: AgentListItem[] }>('/agents')
      setAgents(data.agents)
    } catch {
      // Ignore errors
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchAgents()
  }, [fetchAgents])

  // Keep activeProjectId in sync without a full refetch
  useSSE({
    'agent:active-project': (data) => {
      const agentId = data.agentId as string
      const activeProjectId = (data.activeProjectId as string | null) ?? null
      setAgents((prev) => prev.map((k) => (k.id === agentId ? { ...k, activeProjectId } : k)))
    },
  })

  /** Map of agentId → name */
  const agentNames = new Map(agents.map((k) => [k.id, k.name]))

  /** Map of agentId → avatarUrl */
  const agentAvatars = new Map(agents.map((k) => [k.id, k.avatarUrl]))

  return { agents, agentNames, agentAvatars, isLoading, refetch: fetchAgents }
}
