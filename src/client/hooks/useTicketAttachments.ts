import { useState, useEffect, useCallback } from 'react'
import { api, ApiRequestError } from '@/client/lib/api'
import { useSSE } from '@/client/hooks/useSSE'
import type { TicketAttachment } from '@/shared/types'

interface UploadProgressEntry {
  localId: string
  name: string
  size: number
  status: 'uploading' | 'error'
  error?: string
}

/**
 * Manage the attachments of a single ticket: fetch the list, refresh it on
 * `ticket:updated` SSE events, and expose upload/rename/delete operations.
 *
 * Uploads stream via `fetch` directly (not the JSON `api` helper) because the
 * payload is multipart. Failures surface as `ApiRequestError`-shaped objects
 * so callers can use `getErrorMessage` consistently.
 */
export function useTicketAttachments(ticketId: string | null) {
  const [attachments, setAttachments] = useState<TicketAttachment[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [uploads, setUploads] = useState<UploadProgressEntry[]>([])

  const refetch = useCallback(async () => {
    if (!ticketId) {
      setAttachments([])
      return
    }
    setIsLoading(true)
    try {
      const data = await api.get<{ attachments: TicketAttachment[] }>(
        `/tickets/${ticketId}/attachments`,
      )
      setAttachments(data.attachments ?? [])
    } catch {
      setAttachments([])
    } finally {
      setIsLoading(false)
    }
  }, [ticketId])

  useEffect(() => {
    refetch()
  }, [refetch])

  // Refresh on SSE — the server broadcasts a `ticket:updated` after every
  // mutation, which is good enough for a small list (no need for a dedicated
  // attachment:* channel).
  useSSE({
    'ticket:updated': (data) => {
      const updated = (data as { ticket?: { id?: string } }).ticket
      if (updated?.id === ticketId) {
        refetch().catch(() => undefined)
      }
    },
  })

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!ticketId || files.length === 0) return
      const entries: UploadProgressEntry[] = files.map((f) => ({
        localId: `upl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: f.name,
        size: f.size,
        status: 'uploading',
      }))
      setUploads((prev) => [...prev, ...entries])

      const failures: UploadProgressEntry[] = []
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!
        const entry = entries[i]!
        const formData = new FormData()
        formData.append('files', file)
        try {
          const res = await fetch(`/api/tickets/${ticketId}/attachments`, {
            method: 'POST',
            credentials: 'include',
            body: formData,
          })
          if (!res.ok) {
            const body = await res.json().catch(() => null)
            const message = body?.error?.message ?? 'Upload failed'
            const code = body?.error?.code ?? 'UPLOAD_ERROR'
            failures.push({ ...entry, status: 'error', error: message })
            throw new ApiRequestError(message, code, res.status)
          }
        } catch (err) {
          if (!failures.some((f) => f.localId === entry.localId)) {
            failures.push({
              ...entry,
              status: 'error',
              error: err instanceof Error ? err.message : 'Upload failed',
            })
          }
        }
      }

      // Replace the optimistic entries with whatever survived. The next SSE
      // refresh will reconcile the actual list from the server.
      setUploads((prev) =>
        prev
          .filter((u) => !entries.some((e) => e.localId === u.localId))
          .concat(failures),
      )
      await refetch()
    },
    [refetch, ticketId],
  )

  const dismissUploadError = useCallback((localId: string) => {
    setUploads((prev) => prev.filter((u) => u.localId !== localId))
  }, [])

  const renameAttachment = useCallback(
    async (attachmentId: string, name: string) => {
      if (!ticketId) return
      await api.patch(`/tickets/${ticketId}/attachments/${attachmentId}`, { name })
      await refetch()
    },
    [refetch, ticketId],
  )

  const updateDescription = useCallback(
    async (attachmentId: string, description: string | null) => {
      if (!ticketId) return
      await api.patch(`/tickets/${ticketId}/attachments/${attachmentId}`, { description })
      await refetch()
    },
    [refetch, ticketId],
  )

  const deleteAttachment = useCallback(
    async (attachmentId: string) => {
      if (!ticketId) return
      await api.delete(`/tickets/${ticketId}/attachments/${attachmentId}`)
      await refetch()
    },
    [refetch, ticketId],
  )

  return {
    attachments,
    isLoading,
    uploads,
    refetch,
    uploadFiles,
    dismissUploadError,
    renameAttachment,
    updateDescription,
    deleteAttachment,
  }
}
