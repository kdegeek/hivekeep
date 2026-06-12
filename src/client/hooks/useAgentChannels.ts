import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '@/client/lib/api'
import { useSSE } from '@/client/hooks/useSSE'
import type { ChannelSummary } from '@/shared/types'

export interface AgentChannelBadge {
  id: string
  name: string
  platform: string
  status: ChannelSummary['status']
}

/**
 * Lightweight projection of /api/channels grouped by Agent, for the sidebar
 * binding badges. Refreshes live on the channel:created/updated/deleted
 * and the channel:transferred SSE events broadcast by the service so badges
 * migrate between Agents in real time, regardless of whether the transfer
 * was initiated by the tool, the REST endpoint, or another tab.
 *
 * Pulls only what the badge row needs (id, name, platform, status) to keep
 * the consuming AgentCard prop surface narrow. Inactive channels are dropped
 * client-side: the sidebar is meant to surface "what the Agent is currently
 * reachable on", and an inactive channel does not deliver messages.
 */
export function useAgentChannels() {
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
    'channel:message-received': (data) => {
      // Optimistic increment: bump the counter and lastActivityAt locally so
      // other open tabs / devices see the badge update without waiting for a
      // full refetch. The server already persisted the new value, so we are
      // just reflecting that change client-side.
      const channelId = data.channelId as string
      const now = Date.now()
      setChannels((prev) =>
        prev.map((c) =>
          c.id === channelId
            ? { ...c, messagesReceived: c.messagesReceived + 1, lastActivityAt: now }
            : c,
        ),
      )
    },
    'channel:transferred': (data) => {
      // Optimistic update: rebind locally so the badge migrates immediately
      // without waiting for the next refetch. The authoritative refetch
      // happens right after for safety.
      const channelId = data.channelId as string
      const toAgentId = data.toAgentId as string
      setChannels((prev) => prev.map((c) => (c.id === channelId ? { ...c, agentId: toAgentId } : c)))
      fetchChannels()
    },
  })

  // Group by Agent, drop inactive channels.
  const byAgentId = useMemo(() => {
    const map = new Map<string, AgentChannelBadge[]>()
    for (const ch of channels) {
      if (ch.status !== 'active') continue
      const list = map.get(ch.agentId) ?? []
      list.push({ id: ch.id, name: ch.name, platform: ch.platform, status: ch.status })
      map.set(ch.agentId, list)
    }
    return map
  }, [channels])

  return { byAgentId, isLoading }
}
