import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '@/client/lib/api'
import { useSSE } from '@/client/hooks/useSSE'
import type { ChannelSummary } from '@/shared/types'

export interface KinChannelBadge {
  id: string
  name: string
  platform: string
  status: ChannelSummary['status']
}

/**
 * Lightweight projection of /api/channels grouped by Kin, for the sidebar
 * binding badges. Refreshes live on the channel:created/updated/deleted
 * and the channel:transferred SSE events broadcast by the service so badges
 * migrate between Kins in real time, regardless of whether the transfer
 * was initiated by the tool, the REST endpoint, or another tab.
 *
 * Pulls only what the badge row needs (id, name, platform, status) to keep
 * the consuming KinCard prop surface narrow. Inactive channels are dropped
 * client-side: the sidebar is meant to surface "what the Kin is currently
 * reachable on", and an inactive channel does not deliver messages.
 */
export function useKinChannels() {
  const [channels, setChannels] = useState<ChannelSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const fetchChannels = useCallback(async () => {
    try {
      const data = await api.get<{ channels: ChannelSummary[] }>('/channels')
      setChannels(data.channels)
    } catch {
      // Silent: badges are decorative; an empty row is a fine fallback.
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { fetchChannels() }, [fetchChannels])

  useSSE({
    'channel:created': () => { fetchChannels() },
    'channel:updated': () => { fetchChannels() },
    'channel:deleted': (data) => {
      const channelId = data.channelId as string
      setChannels((prev) => prev.filter((c) => c.id !== channelId))
    },
    'channel:transferred': (data) => {
      // Optimistic update: rebind locally so the badge migrates immediately
      // without waiting for the next refetch. The authoritative refetch
      // happens right after for safety.
      const channelId = data.channelId as string
      const toKinId = data.toKinId as string
      setChannels((prev) => prev.map((c) => (c.id === channelId ? { ...c, kinId: toKinId } : c)))
      fetchChannels()
    },
  })

  // Group by Kin, drop inactive channels.
  const byKinId = useMemo(() => {
    const map = new Map<string, KinChannelBadge[]>()
    for (const ch of channels) {
      if (ch.status !== 'active') continue
      const list = map.get(ch.kinId) ?? []
      list.push({ id: ch.id, name: ch.name, platform: ch.platform, status: ch.status })
      map.set(ch.kinId, list)
    }
    return map
  }, [channels])

  return { byKinId, isLoading }
}
