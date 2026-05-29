import { useState, useEffect, useCallback } from 'react'
import { api } from '@/client/lib/api'
import type { ToolCatalogEntry } from '@/shared/types'

interface ToolCatalogResponse {
  tools: ToolCatalogEntry[]
}

/**
 * Loads the tool catalog (GET /api/tools/catalog). This is pure metadata —
 * every grantable tool across all four sources (native, plugin, MCP, custom)
 * with its source, domain, label, description, and `hardExcludedFromSubKin`
 * flag — used to populate the toolbox editor and any other surface that lets a
 * user pick tools by name (not per-Kin enabled state, which still comes from
 * useKinTools).
 *
 * Native + plugin tools come from the registry; MCP tools come from ALL global
 * active servers (no per-Kin gate). Custom tools are per-Kin and are ONLY
 * included when `kinId` is supplied — without it, the catalog omits them.
 */
export function useToolCatalog(kinId?: string | null) {
  const [tools, setTools] = useState<ToolCatalogEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const refetch = useCallback(async () => {
    setIsLoading(true)
    try {
      const path = kinId ? `/tools/catalog?kinId=${encodeURIComponent(kinId)}` : '/tools/catalog'
      const data = await api.get<ToolCatalogResponse>(path)
      setTools(data.tools)
    } catch (err) {
      console.error('[useToolCatalog] error:', err)
    } finally {
      setIsLoading(false)
    }
  }, [kinId])

  useEffect(() => {
    refetch()
  }, [refetch])

  return { tools, isLoading, refetch }
}
