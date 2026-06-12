import { useState, useEffect, useCallback } from 'react'
import { api } from '@/client/lib/api'

export interface AgentToolInfo {
  name: string
  description: string
}

/**
 * The agent's RESOLVED toolset — the exact tools a turn would receive (native +
 * plugin + MCP + custom, after toolbox gating). `quick: true` returns the
 * quick-session variant (sans the session-excluded tools). Drives the tools
 * badge in the composer and its listing modal.
 */
export function useAgentTools(agentId: string | null, opts: { quick?: boolean } = {}) {
  const [tools, setTools] = useState<AgentToolInfo[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const refetch = useCallback(async () => {
    if (!agentId) {
      setTools([])
      return
    }
    setIsLoading(true)
    try {
      const data = await api.get<{ tools: AgentToolInfo[] }>(
        `/agents/${agentId}/tools${opts.quick ? '?quick=1' : ''}`,
      )
      setTools(data.tools)
    } catch {
      // Cosmetic surface (badge count) — keep whatever we had.
    } finally {
      setIsLoading(false)
    }
  }, [agentId, opts.quick])

  useEffect(() => { void refetch() }, [refetch])

  return { tools, count: tools.length, isLoading, refetch }
}
