/**
 * Debounced ticket search hook for the composer's `#` autocomplete.
 *
 * Usage:
 *
 *   const { hits, isLoading, error } = useTicketSearch({
 *     query: '23',
 *     projectId: agent.activeProjectId,
 *     projectSlug: null,
 *     enabled: true,
 *   })
 *
 * Semantics:
 *
 *   - The hook only fires when `enabled` is true. When the popover closes the
 *     caller flips this flag and the hook stops issuing requests immediately.
 *   - A `projectSlug` overrides `projectId` (used for cross-project mentions
 *     like `soup#login`). When both are null/empty the hook returns nothing.
 *   - Requests are debounced (default 150 ms) so each keystroke does not hit
 *     the server. The in-flight request is cancelled when a newer query
 *     supersedes it — only the latest result lands in state.
 */
import { useEffect, useRef, useState } from 'react'
import { api } from '@/client/lib/api'
import type { TicketStatus, ProjectTag } from '@/shared/types'

export interface TicketSearchHit {
  id: string
  number: number
  title: string
  status: TicketStatus
  projectId: string
  projectSlug: string
  projectName: string
  primaryTag: ProjectTag | null
  updatedAt: number
  createdAt: number
}

interface SearchResponse {
  hits: TicketSearchHit[]
}

export interface UseTicketSearchOptions {
  /** The free-form query (numeric prefix or title substring). */
  query: string
  /** The active project's UUID. Used when no slug prefix is present. */
  projectId: string | null
  /** Cross-project search via a slug prefix typed by the user. Overrides
   *  projectId when set. */
  projectSlug: string | null
  /** Disable the hook entirely (e.g. popover closed). */
  enabled: boolean
  /** Debounce window in ms. Default: 150. */
  debounceMs?: number
  /** Whether to include `done` tickets. Default: true. */
  includeDone?: boolean
}

export interface UseTicketSearchResult {
  hits: TicketSearchHit[]
  isLoading: boolean
  error: string | null
}

const DEFAULT_DEBOUNCE_MS = 150

/**
 * Build the search query string for the autocomplete endpoint. Pure function
 * exposed for unit tests — keeps the hook itself thin and avoids needing a
 * DOM-aware test runner. Returns `null` when the inputs make a search
 * impossible (no scope at all).
 */
export function buildTicketSearchUrl(opts: {
  query: string
  projectId: string | null
  projectSlug: string | null
  includeDone?: boolean
}): string | null {
  const { query, projectId, projectSlug } = opts
  if (!projectSlug && !projectId) return null
  const params = new URLSearchParams()
  if (query) params.set('q', query)
  if (projectSlug) {
    params.set('projectSlug', projectSlug)
  } else if (projectId) {
    params.set('projectId', projectId)
  }
  if (opts.includeDone === false) params.set('includeDone', '0')
  return `/tickets/search?${params.toString()}`
}

/**
 * Public hook. The result is stable across renders when inputs don't change,
 * so it's safe to feed straight into a memoized popover.
 */
export function useTicketSearch(opts: UseTicketSearchOptions): UseTicketSearchResult {
  const {
    query,
    projectId,
    projectSlug,
    enabled,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    includeDone = true,
  } = opts

  const [hits, setHits] = useState<TicketSearchHit[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Each request bumps this counter; only the latest one is allowed to write
  // to state. This guards against out-of-order responses on slow networks.
  const requestSeqRef = useRef(0)

  useEffect(() => {
    if (!enabled) {
      setHits([])
      setIsLoading(false)
      setError(null)
      return
    }

    // Without a project to scope against we cannot search — return empty.
    if (!projectSlug && !projectId) {
      setHits([])
      setIsLoading(false)
      setError(null)
      return
    }

    const url = buildTicketSearchUrl({ query, projectId, projectSlug, includeDone })
    if (!url) {
      setHits([])
      setIsLoading(false)
      setError(null)
      return
    }
    setIsLoading(true)

    const seq = ++requestSeqRef.current
    const handle = setTimeout(async () => {
      try {
        const data = await api.get<SearchResponse>(url)
        if (seq !== requestSeqRef.current) return // superseded
        setHits(Array.isArray(data.hits) ? data.hits : [])
        setError(null)
      } catch (err) {
        if (seq !== requestSeqRef.current) return
        setError(err instanceof Error ? err.message : 'Search failed')
        setHits([])
      } finally {
        if (seq === requestSeqRef.current) setIsLoading(false)
      }
    }, debounceMs)

    return () => {
      clearTimeout(handle)
    }
  }, [enabled, query, projectId, projectSlug, debounceMs, includeDone])

  return { hits, isLoading, error }
}
