import { useState, useEffect, useRef } from 'react'
import { api } from '@/client/lib/api'

export interface WorkspaceFileHit {
  path: string
  name: string
  size: number
  modifiedAt: number
}

/** Pure URL builder (tested separately — repo convention: hooks stay thin). */
export function buildWorkspaceSearchUrl(params: { agentId: string | null; query: string; limit: number }): string | null {
  if (!params.agentId) return null
  const qs = new URLSearchParams()
  if (params.query) qs.set('q', params.query)
  qs.set('limit', String(Math.max(1, Math.min(params.limit, 50))))
  return `/agents/${encodeURIComponent(params.agentId)}/workspace/search?${qs.toString()}`
}

interface UseWorkspaceFileSearchOptions {
  query: string
  agentId: string | null
  enabled: boolean
  debounceMs?: number
  limit?: number
}

/**
 * Server-side workspace filename search for the `@` palette and the quick-open
 * dialog (files.md § 5.1) — same debounce + request-sequencing pattern as
 * useTicketSearch so slow responses never land out of order.
 */
export function useWorkspaceFileSearch({
  query,
  agentId,
  enabled,
  debounceMs = 150,
  limit = 8,
}: UseWorkspaceFileSearchOptions) {
  const [hits, setHits] = useState<WorkspaceFileHit[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const requestSeqRef = useRef(0)

  useEffect(() => {
    if (!enabled || !agentId) {
      setHits([])
      setIsLoading(false)
      return
    }
    const url = buildWorkspaceSearchUrl({ agentId, query, limit })
    if (!url) return
    const seq = ++requestSeqRef.current
    setIsLoading(true)
    const handle = setTimeout(async () => {
      try {
        const data = await api.get<{ hits: WorkspaceFileHit[] }>(url)
        if (seq !== requestSeqRef.current) return // superseded — drop silently
        setHits(data.hits)
        setIsLoading(false)
      } catch {
        if (seq !== requestSeqRef.current) return
        setHits([])
        setIsLoading(false)
      }
    }, debounceMs)
    return () => clearTimeout(handle)
  }, [query, agentId, enabled, debounceMs, limit])

  return { hits, isLoading }
}
