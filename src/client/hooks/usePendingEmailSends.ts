import { useCallback, useEffect, useState } from 'react'
import { api } from '@/client/lib/api'
import { useSSE } from '@/client/hooks/useSSE'
import type { PendingEmailSend } from '@/shared/types'

export function usePendingEmailSends() {
  const [pending, setPending] = useState<PendingEmailSend[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const refetch = useCallback(async () => {
    try {
      const d = await api.get<{ pending: PendingEmailSend[] }>('/pending-email-sends')
      setPending(d.pending)
    } catch {
      // Surfaced by individual actions; the list just stays as-is.
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void refetch()
  }, [refetch])

  useSSE({
    'email:pending-created': () => void refetch(),
    'email:pending-resolved': () => void refetch(),
  })

  const approve = useCallback(
    async (id: string) => {
      await api.post(`/pending-email-sends/${id}/approve`)
      await refetch()
    },
    [refetch],
  )

  const reject = useCallback(
    async (id: string) => {
      await api.post(`/pending-email-sends/${id}/reject`)
      await refetch()
    },
    [refetch],
  )

  return { pending, isLoading, refetch, approve, reject }
}
