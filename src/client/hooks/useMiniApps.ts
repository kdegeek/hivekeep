import { useState, useEffect, useCallback } from 'react'
import { api } from '@/client/lib/api'
import { useSSE, useSSEResync } from '@/client/hooks/useSSE'
import type { MiniAppSummary } from '@/shared/types'

interface MiniAppsResponse {
  apps: MiniAppSummary[]
}

export function useMiniApps(agentId: string | null, mode: 'agent' | 'all' = 'agent') {
  const [apps, setApps] = useState<MiniAppSummary[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const fetchApps = useCallback(async () => {
    if (mode === 'agent' && !agentId) {
      setApps([])
      return
    }
    setIsLoading(true)
    try {
      const endpoint = mode === 'all'
        ? '/mini-apps'
        : `/mini-apps?agentId=${agentId}`
      const data = await api.get<MiniAppsResponse>(endpoint)
      setApps(data.apps)
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false)
    }
  }, [agentId, mode])

  useEffect(() => {
    fetchApps()
  }, [fetchApps])

  const deleteApp = useCallback(async (appId: string) => {
    await api.delete(`/mini-apps/${appId}`)
    setApps((prev) => prev.filter((a) => a.id !== appId))
  }, [])

  // SSE: real-time mini-app updates
  useSSE({
    'miniapp:created': (data) => {
      if (mode === 'agent' && data.agentId !== agentId) return
      const app = data.app as MiniAppSummary
      setApps((prev) => [app, ...prev])
    },
    'miniapp:updated': (data) => {
      const app = data.app as MiniAppSummary
      // In agent-scoped mode the maintainer may have changed: drop the app if it
      // moved away from this Agent, add it if it moved in, else update in place.
      if (mode === 'agent' && data.agentId !== agentId) {
        setApps((prev) => prev.filter((a) => a.id !== app.id))
        return
      }
      setApps((prev) =>
        prev.some((a) => a.id === app.id)
          ? prev.map((a) => (a.id === app.id ? app : a))
          : [app, ...prev],
      )
    },
    'miniapp:deleted': (data) => {
      if (mode === 'agent' && data.agentId !== agentId) return
      const appId = data.appId as string
      setApps((prev) => prev.filter((a) => a.id !== appId))
    },
  })

  useSSEResync(fetchApps)

  return {
    apps,
    isLoading,
    refetch: fetchApps,
    deleteApp,
  }
}
