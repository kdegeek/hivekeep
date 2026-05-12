import { useState, useEffect, useCallback } from 'react'
import { api } from '@/client/lib/api'
import type { ToolDomain } from '@/shared/types'

export interface NativeToolGroup {
  domain: ToolDomain
  tools: Array<{ name: string; enabled: boolean; defaultDisabled?: boolean }>
}

export interface PluginToolGroup {
  pluginName: string
  tools: Array<{ name: string; enabled: boolean; defaultDisabled?: boolean }>
}

export interface McpToolGroup {
  serverId: string
  serverName: string
  autoEnabled: boolean
  tools: Array<{ name: string; description: string; enabled: boolean }>
}

interface KinToolsResponse {
  nativeTools: NativeToolGroup[]
  pluginTools?: PluginToolGroup[]
  mcpTools: McpToolGroup[]
}

export function useKinTools(kinId: string | null) {
  const [nativeTools, setNativeTools] = useState<NativeToolGroup[]>([])
  const [pluginTools, setPluginTools] = useState<PluginToolGroup[]>([])
  const [mcpTools, setMcpTools] = useState<McpToolGroup[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const fetchTools = useCallback(async () => {
    if (!kinId) return
    setIsLoading(true)
    try {
      const data = await api.get<KinToolsResponse>(`/kins/${kinId}/tools`)
      setNativeTools(data.nativeTools)
      setPluginTools(data.pluginTools ?? [])
      setMcpTools(data.mcpTools)
    } catch (err) {
      console.error('[useKinTools] error:', err)
    } finally {
      setIsLoading(false)
    }
  }, [kinId])

  useEffect(() => {
    fetchTools()
  }, [fetchTools])

  return { nativeTools, pluginTools, mcpTools, isLoading, refetch: fetchTools }
}
