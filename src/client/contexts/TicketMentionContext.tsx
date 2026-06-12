/**
 * Ticket mention resolution cache.
 *
 * Markdown renderers can call `useTicketMention(raw)` to get the live state of
 * a `#42` or `hivekeep#42` reference. The provider:
 *
 *   1. Coalesces every requested ref into a single in-memory cache, so a given
 *      ref is fetched at most once per session.
 *   2. Batches pending fetches with a short debounce (50ms) so a long message
 *      with 10 mentions becomes one HTTP call, not ten.
 *   3. Subscribes to the global SSE `ticket:updated` / `ticket:deleted` events
 *      and refreshes cached entries in place — mentions reflect status changes
 *      live without re-rendering the entire message tree.
 *
 * Bare `#N` refs are resolved against the *current* active project provided
 * by the consumer. The cache is keyed by `(activeProjectId, raw)` for bare
 * refs so switching Agents/projects doesn't mix resolutions.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { api } from '@/client/lib/api'
import { useSSE } from '@/client/hooks/useSSE'
import type { TicketStatus } from '@/shared/types'

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ResolvedTicketMention {
  found: true
  id: string
  number: number
  title: string
  status: TicketStatus
  projectId: string
  projectSlug: string
  projectName: string
}

export interface UnresolvedTicketMention {
  found: false
  reason: string
}

export type TicketMentionState =
  | { state: 'pending' }
  | { state: 'resolved'; data: ResolvedTicketMention }
  | { state: 'missing'; reason: string }

interface BatchPayload {
  resolutions: Record<string, ResolvedTicketMention | UnresolvedTicketMention>
}

// ─── Internal store ───────────────────────────────────────────────────────────

type CacheKey = string

/** Build the cache key. Bare refs (no slug, leading `#`) are namespaced by the
 *  active project so the same `#42` resolves correctly when switching Agents. */
function cacheKey(raw: string, activeProjectId: string | null): CacheKey {
  // A "bare" ref does not contain a `slug#`. We detect that cheaply.
  const hasSlugPrefix = /^[a-z][a-z0-9-]*#/.test(raw)
  if (hasSlugPrefix) return `q:${raw}`
  return `b:${activeProjectId ?? ''}:${raw}`
}

const BATCH_DEBOUNCE_MS = 50
const BATCH_MAX = 50

/** Imperative API exposed to the hook. Stored in context as a stable ref so
 *  the hook itself can call useState/useEffect without re-creating subscribers
 *  on each render. */
interface MentionStore {
  /** Build the cache key for a raw ref using the current active project. */
  keyFor(raw: string): CacheKey
  /** Read the current state for a key, or undefined if never registered. */
  get(key: CacheKey): TicketMentionState | undefined
  /** Subscribe a listener; returns an unsubscribe fn. */
  subscribe(key: CacheKey, listener: () => void): () => void
  /** Ensure the ref is in-flight or resolved. */
  request(raw: string, key: CacheKey): void
}

const TicketMentionContext = createContext<MentionStore | null>(null)

interface ProviderProps {
  /** UUID of the active project (or null). Used to namespace bare `#N` refs. */
  activeProjectId: string | null
  children: ReactNode
}

export function TicketMentionProvider({ activeProjectId, children }: ProviderProps) {
  const cacheRef = useRef<Map<CacheKey, TicketMentionState>>(new Map())
  const listenersRef = useRef<Map<CacheKey, Set<() => void>>>(new Map())
  const pendingRef = useRef<Map<CacheKey, string>>(new Map())
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeProjectIdRef = useRef(activeProjectId)
  activeProjectIdRef.current = activeProjectId

  const setEntry = useCallback((key: CacheKey, entry: TicketMentionState) => {
    cacheRef.current.set(key, entry)
    const subs = listenersRef.current.get(key)
    if (subs) for (const cb of subs) cb()
  }, [])

  const flush = useCallback(async () => {
    timerRef.current = null
    const pending = pendingRef.current
    if (pending.size === 0) return
    const batch = Array.from(pending.entries())
    pending.clear()

    for (let i = 0; i < batch.length; i += BATCH_MAX) {
      const chunk = batch.slice(i, i + BATCH_MAX)
      const refs = chunk.map(([, raw]) => raw)
      try {
        const data = await api.post<BatchPayload>('/tickets/resolve-mentions', {
          refs,
          activeProjectId: activeProjectIdRef.current,
        })
        const resolutions = data.resolutions ?? {}
        for (const [key, raw] of chunk) {
          const r = resolutions[raw]
          if (r && r.found) {
            setEntry(key, { state: 'resolved', data: r })
          } else if (r) {
            setEntry(key, { state: 'missing', reason: r.reason })
          } else {
            setEntry(key, { state: 'missing', reason: 'UNKNOWN' })
          }
        }
      } catch {
        // Network/parse error: drop entries so a later mount can retry.
        for (const [key] of chunk) {
          cacheRef.current.delete(key)
          const subs = listenersRef.current.get(key)
          if (subs) for (const cb of subs) cb()
        }
      }
    }
  }, [setEntry])

  const scheduleFlush = useCallback(() => {
    if (timerRef.current !== null) return
    timerRef.current = setTimeout(flush, BATCH_DEBOUNCE_MS)
  }, [flush])

  // ── SSE: live updates ───────────────────────────────────────────────────
  useSSE({
    'ticket:updated': (data) => {
      const ticket = data.ticket as
        | {
            id: string
            number: number | null
            title: string
            status: TicketStatus
            projectId: string
          }
        | undefined
      if (!ticket || ticket.number === null) return
      for (const [key, entry] of cacheRef.current) {
        if (entry.state === 'resolved' && entry.data.id === ticket.id) {
          setEntry(key, {
            state: 'resolved',
            data: { ...entry.data, title: ticket.title, status: ticket.status },
          })
        }
      }
    },
    'ticket:deleted': (data) => {
      const { ticketId } = data as { ticketId?: string }
      if (!ticketId) return
      for (const [key, entry] of cacheRef.current) {
        if (entry.state === 'resolved' && entry.data.id === ticketId) {
          setEntry(key, { state: 'missing', reason: 'TICKET_NOT_FOUND' })
        }
      }
    },
  })

  const store = useMemo<MentionStore>(() => ({
    keyFor(raw) {
      return cacheKey(raw, activeProjectIdRef.current)
    },
    get(key) {
      return cacheRef.current.get(key)
    },
    subscribe(key, listener) {
      const set = listenersRef.current.get(key) ?? new Set<() => void>()
      set.add(listener)
      listenersRef.current.set(key, set)
      return () => {
        set.delete(listener)
        if (set.size === 0) listenersRef.current.delete(key)
      }
    },
    request(raw, key) {
      if (cacheRef.current.has(key)) return
      cacheRef.current.set(key, { state: 'pending' })
      pendingRef.current.set(key, raw)
      scheduleFlush()
    },
  }), [scheduleFlush])

  return <TicketMentionContext.Provider value={store}>{children}</TicketMentionContext.Provider>
}

/** Resolve a single ticket mention ref. Returns `{ state: 'pending' }` until
 *  the batched server lookup returns. When no provider is mounted, returns a
 *  permanent `pending` so the calling component can fall back to literal text. */
export function useTicketMention(raw: string): TicketMentionState {
  const store = useContext(TicketMentionContext)
  // Derive the cache key from the store so bare refs are namespaced by the
  // current active project. Outside the provider the key is unused.
  const key = store ? store.keyFor(raw) : ''

  // We always call useState + useEffect; if there's no store the effect is a
  // no-op and state stays at the initial pending value.
  const [, force] = useState(0)

  useEffect(() => {
    if (!store) return
    store.request(raw, key)
    const unsub = store.subscribe(key, () => force((n) => n + 1))
    return unsub
  }, [store, raw, key])

  if (!store) return { state: 'pending' }
  return store.get(key) ?? { state: 'pending' }
}
