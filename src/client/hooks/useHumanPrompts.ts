import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { api, toastError, ApiRequestError } from '@/client/lib/api'
import { useSSE, useSSEResync } from '@/client/hooks/useSSE'
import type { HumanPromptSummary } from '@/shared/types'

/**
 * Manages pending human prompts for a given Agent (and optionally a specific task).
 * Fetches pending prompts on mount, listens for SSE events, and provides a respond function.
 */
export function useHumanPrompts(agentId: string | null, taskId?: string | null) {
  const [prompts, setPrompts] = useState<HumanPromptSummary[]>([])
  const [isResponding, setIsResponding] = useState(false)

  // Fetch pending prompts on mount / agentId change
  const fetchPending = useCallback(async () => {
    if (!agentId) {
      setPrompts([])
      return
    }
    const params = new URLSearchParams({ agentId })
    if (taskId) params.set('taskId', taskId)
    try {
      const data = await api.get<{ prompts: HumanPromptSummary[] }>(`/prompts/pending?${params}`)
      setPrompts(data.prompts)
    } catch {
      // Ignore fetch errors — prompts will appear via SSE
    }
  }, [agentId, taskId])

  useEffect(() => {
    fetchPending()
  }, [fetchPending])

  // SSE handlers
  useSSE({
    'prompt:pending': (data) => {
      if (data.agentId !== agentId) return
      if (taskId !== undefined && taskId !== null && data.taskId !== taskId) return

      const newPrompt: HumanPromptSummary = {
        id: data.promptId as string,
        agentId: data.agentId as string,
        taskId: (data.taskId as string) ?? null,
        promptType: data.promptType as HumanPromptSummary['promptType'],
        question: data.question as string,
        description: (data.description as string) ?? null,
        options: data.options as HumanPromptSummary['options'],
        response: null,
        status: 'pending',
        createdAt: Date.now(),
        respondedAt: null,
      }
      setPrompts((prev) => [...prev, newPrompt])
    },
    'prompt:answered': (data) => {
      if (data.agentId !== agentId) return
      const promptId = data.promptId as string
      setPrompts((prev) => prev.filter((p) => p.id !== promptId))
    },
    // Server-side late-response expiry: the user typed an answer but the
    // task had already reached a terminal state. The prompt is dropped from
    // the UI and the user sees a toast (raised below in `respond` when the
    // POST returned TASK_ALREADY_FINISHED). This SSE handles the rare cross-
    // tab / multi-client case where ANOTHER session expired the prompt.
    'prompt:expired': (data) => {
      if (data.agentId !== agentId) return
      const promptId = data.promptId as string
      setPrompts((prev) => prev.filter((p) => p.id !== promptId))
    },
  })

  // Catch up on prompts missed while backgrounded or disconnected
  useSSEResync(fetchPending)

  // Submit a response to a prompt
  const respond = useCallback(async (promptId: string, response: unknown) => {
    setIsResponding(true)
    try {
      await api.post(`/prompts/${promptId}/respond`, { response })
      // Optimistic removal
      setPrompts((prev) => prev.filter((p) => p.id !== promptId))
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'TASK_ALREADY_FINISHED') {
        // The task ran to completion (or failed / was cancelled) before this
        // answer arrived. The server marked the prompt as `expired` and
        // recorded the response for audit. Drop the card client-side and
        // surface a clear toast instead of the generic API error.
        setPrompts((prev) => prev.filter((p) => p.id !== promptId))
        toast.warning(err.message)
        return
      }
      toastError(err)
      throw err
    } finally {
      setIsResponding(false)
    }
  }, [])

  return { prompts, respond, isResponding, refetch: fetchPending }
}
