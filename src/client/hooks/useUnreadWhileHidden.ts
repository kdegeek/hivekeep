import { useCallback, useEffect, useRef, useState } from 'react'
import { useSSE } from '@/client/hooks/useSSE'

/**
 * Track new assistant messages that arrive while the browser tab is hidden.
 *
 * Returns the current unread count, which resets to 0 when the user
 * returns to the tab. The count only increments for assistant messages
 * in the given agent (ignores tasks and quick sessions).
 */
export function useUnreadWhileHidden(agentId: string | null): number {
  const [unreadCount, setUnreadCount] = useState(0)
  const hiddenRef = useRef(document.hidden)

  // Track page visibility
  useEffect(() => {
    const handleVisibility = () => {
      hiddenRef.current = document.hidden
      if (!document.hidden) {
        // User came back — reset unread count
        setUnreadCount(0)
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [])

  // Listen for new chat messages via SSE
  const handleMessage = useCallback(
    (data: Record<string, unknown>) => {
      // Only count messages for the active agent
      if (data.agentId !== agentId) return
      // Skip task and quick session messages
      if (data.taskId || data.sessionId) return
      // Only count assistant messages (not user echo)
      if (data.role !== 'assistant') return
      // Only increment when tab is hidden
      if (hiddenRef.current) {
        setUnreadCount((c) => c + 1)
      }
    },
    [agentId],
  )

  useSSE({
    'chat:message': handleMessage,
  })

  return unreadCount
}
