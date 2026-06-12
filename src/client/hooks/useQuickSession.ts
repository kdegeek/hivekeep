import { useState, useCallback, useEffect } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { api } from '@/client/lib/api'
import { useSSE } from '@/client/hooks/useSSE'
import type { QuickSessionSummary } from '@/shared/types'

export function useQuickSession(agentId: string | null) {
  const { t } = useTranslation()
  const [activeSession, setActiveSession] = useState<QuickSessionSummary | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)

  // Fetch active sessions on mount / agentId change
  const fetchSessions = useCallback(async () => {
    if (!agentId) {
      setActiveSession(null)
      return
    }
    try {
      const data = await api.get<{ sessions: QuickSessionSummary[] }>(
        `/agents/${agentId}/quick-sessions`,
      )
      // If there's an active session, restore it
      const first = data.sessions[0]
      setActiveSession(first ?? null)
    } catch {
      toast.error(t('quickSession.errors.fetchFailed', 'Failed to load quick sessions'))
    }
  }, [agentId, t])

  useEffect(() => {
    fetchSessions()
    setIsOpen(false)
  }, [fetchSessions])

  // Create a new quick session and open the panel
  const createSession = useCallback(async (title?: string) => {
    if (!agentId || isCreating) return null
    setIsCreating(true)
    try {
      const session = await api.post<QuickSessionSummary>(
        `/agents/${agentId}/quick-sessions`,
        { title },
      )
      setActiveSession(session)
      setIsOpen(true)
      return session
    } catch {
      toast.error(t('quickSession.errors.createFailed', 'Failed to create quick session'))
      return null
    } finally {
      setIsCreating(false)
    }
  }, [agentId, isCreating, t])

  // Close a session (with optional save-as-memory)
  const closeSession = useCallback(async (
    sessionId: string,
    saveMemory?: boolean,
    memorySummary?: string,
  ) => {
    try {
      await api.post(`/quick-sessions/${sessionId}/close`, {
        saveMemory,
        memorySummary,
      })
      setActiveSession(null)
      setIsOpen(false)
    } catch {
      toast.error(t('quickSession.errors.closeFailed', 'Failed to close session. Please try again.'))
    }
  }, [t])

  // SSE listener for session events
  useSSE({
    'quick-session:closed': (data) => {
      if (activeSession && data.sessionId === activeSession.id) {
        setActiveSession(null)
        setIsOpen(false)
      }
    },
  })

  return {
    activeSession,
    isOpen,
    setIsOpen,
    isCreating,
    createSession,
    closeSession,
  }
}
