import { useState, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { api } from '@/client/lib/api'
import type { QuickSessionSummary } from '@/shared/types'
import type { ChatMessage } from '@/client/hooks/useChat'

const PAGE_SIZE = 20

export function useQuickSessionHistory(agentId: string | null) {
  const { t } = useTranslation()
  const [sessions, setSessions] = useState<QuickSessionSummary[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [selectedMessages, setSelectedMessages] = useState<ChatMessage[]>([])
  const [selectedSession, setSelectedSession] = useState<QuickSessionSummary | null>(null)
  const [isLoadingMessages, setIsLoadingMessages] = useState(false)
  const offsetRef = useRef(0)

  const fetchHistory = useCallback(async () => {
    if (!agentId) return
    setIsLoading(true)
    offsetRef.current = 0
    try {
      const data = await api.get<{ sessions: QuickSessionSummary[]; hasMore: boolean }>(
        `/agents/${agentId}/quick-sessions?status=closed&limit=${PAGE_SIZE}&offset=0`,
      )
      setSessions(data.sessions)
      setHasMore(data.hasMore)
      offsetRef.current = data.sessions.length
    } catch {
      toast.error(t('quickSession.errors.fetchHistoryFailed', 'Failed to load session history'))
    } finally {
      setIsLoading(false)
    }
  }, [agentId])

  const loadMore = useCallback(async () => {
    if (!agentId || isLoadingMore || !hasMore) return
    setIsLoadingMore(true)
    try {
      const data = await api.get<{ sessions: QuickSessionSummary[]; hasMore: boolean }>(
        `/agents/${agentId}/quick-sessions?status=closed&limit=${PAGE_SIZE}&offset=${offsetRef.current}`,
      )
      setSessions((prev) => [...prev, ...data.sessions])
      setHasMore(data.hasMore)
      offsetRef.current += data.sessions.length
    } catch {
      toast.error(t('quickSession.errors.fetchHistoryFailed', 'Failed to load session history'))
    } finally {
      setIsLoadingMore(false)
    }
  }, [agentId, isLoadingMore, hasMore])

  const viewSession = useCallback(async (session: QuickSessionSummary) => {
    setSelectedSession(session)
    setIsLoadingMessages(true)
    try {
      const data = await api.get<{ session: any; messages: ChatMessage[] }>(
        `/quick-sessions/${session.id}`,
      )
      setSelectedMessages(data.messages)
    } catch {
      setSelectedMessages([])
      toast.error(t('quickSession.errors.viewSessionFailed', 'Failed to load session messages'))
    } finally {
      setIsLoadingMessages(false)
    }
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedSession(null)
    setSelectedMessages([])
  }, [])

  return {
    sessions,
    isLoading,
    isLoadingMore,
    hasMore,
    selectedSession,
    selectedMessages,
    isLoadingMessages,
    fetchHistory,
    loadMore,
    viewSession,
    clearSelection,
  }
}
