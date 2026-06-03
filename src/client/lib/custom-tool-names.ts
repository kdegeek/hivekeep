import { useSyncExternalStore } from 'react'
import { api } from '@/client/lib/api'

/**
 * Client-side reactive store of custom-tool UI metadata.
 *
 * A snapshot is fetched from the server (the source of truth, resolved for the
 * current user's UI language):
 *   `custom_<slug>` → { name, hasRenderer, rendererVersion }   (GET /api/tools/custom-tool-names)
 *
 * Two consumers:
 *   - chat tool-call components show the localized `name` instead of the raw
 *     `custom_<slug>` technical name;
 *   - the expanded tool-call view uses `hasRenderer` to decide whether to attempt
 *     loading a server-bundled result renderer (so it only fetches /renderer.js
 *     for tools that actually ship one).
 *
 * Reactivity: a tiny `useSyncExternalStore`-based hook (`useCustomToolMeta`)
 * subscribes chat components to cache changes so a tool created/edited DURING
 * the session (or after a renderer is added to an already-cached tool) is picked
 * up without a reload. The store:
 *   - refetches on a MISS (cache loaded but key absent) once per key, so a tool
 *     created after boot appears the next time it is encountered;
 *   - is force-invalidated on save (`refreshCustomToolNames()`), which covers the
 *     "renderer added to an already-cached key" case the miss path can't.
 *
 * The map is best-effort: while it is cold (or on a fetch failure) the accessors
 * return `null` / `false` so callers fall back to the existing i18n key / raw
 * name and the default JSON viewer.
 */

interface CustomToolEntry {
  name: string
  hasRenderer: boolean
  /** Renderer file mtimeMs (null when the tool ships no renderer). Folded into the
   *  versioned, immutable `/renderer.js?v=<version>` URL: stable → cached/instant,
   *  and an edit (new mtime) → new key → fresh load. */
  rendererVersion: number | null
}

let cache: Record<string, CustomToolEntry> | null = null
let pending: Promise<void> | null = null

// Keys that triggered a refetch-on-miss already, so a genuinely-absent key can't
// cause a refetch storm. Cleared on every successful (re)load.
const missAttempted = new Set<string>()

// Subscribers (useSyncExternalStore subscribe callbacks).
const listeners = new Set<() => void>()

// Per-toolName memoized snapshot objects. useSyncExternalStore requires
// getSnapshot to return a STABLE reference when the value is unchanged; building
// a fresh object every call would loop forever. We cache one object per toolName
// and only replace it when its name/hasRenderer actually change.
interface ToolMeta {
  name: string | null
  hasRenderer: boolean
  rendererVersion: number | null
}
const COLD: ToolMeta = { name: null, hasRenderer: false, rendererVersion: null }
const snapshots = new Map<string, ToolMeta>()

function emit(): void {
  // The cache changed → recompute every cached snapshot, replacing only those
  // whose value actually changed (keeps references stable for unchanged keys),
  // then notify subscribers.
  for (const [toolName, prev] of snapshots) {
    const entry = cache?.[toolName]
    const name = entry?.name ?? null
    const hasRenderer = entry?.hasRenderer ?? false
    const rendererVersion = entry?.rendererVersion ?? null
    if (
      prev.name !== name ||
      prev.hasRenderer !== hasRenderer ||
      prev.rendererVersion !== rendererVersion
    ) {
      snapshots.set(toolName, { name, hasRenderer, rendererVersion })
    }
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Stable per-toolName snapshot for useSyncExternalStore. */
function getSnapshot(toolName: string): ToolMeta {
  const existing = snapshots.get(toolName)
  if (existing) return existing
  const entry = cache?.[toolName]
  // No memoized snapshot yet: build one. When cold/absent it is the shared COLD
  // constant (stable reference) so we don't allocate per call for unknown keys.
  if (!entry) {
    snapshots.set(toolName, COLD)
    return COLD
  }
  const snap: ToolMeta = {
    name: entry.name,
    hasRenderer: entry.hasRenderer,
    rendererVersion: entry.rendererVersion ?? null,
  }
  snapshots.set(toolName, snap)
  return snap
}

export async function loadCustomToolNames(): Promise<void> {
  if (cache) return
  if (pending) return pending
  pending = api
    .get<Record<string, CustomToolEntry>>('/tools/custom-tool-names')
    .then((map) => {
      cache = map
      missAttempted.clear()
      emit()
      // Warm every renderer module + the shared lazy cache now, off the critical
      // path, so the first tool-call renders instantly (no cold-load spinner).
      prefetchCustomToolRenderers()
    })
    .catch(() => {
      // Leave cache null so subsequent calls retry. Falling back to the i18n
      // key / raw name keeps the chat UI rendering.
    })
    .finally(() => {
      pending = null
    })
  return pending
}

/** Force a background refresh of the cache (used after a miss or on save). */
function refetch(): void {
  if (pending) return
  pending = api
    .get<Record<string, CustomToolEntry>>('/tools/custom-tool-names')
    .then((map) => {
      cache = map
      missAttempted.clear()
      emit()
      // A save may have added/edited a renderer → warm the new version(s) too.
      prefetchCustomToolRenderers()
    })
    .catch(() => {
      // Keep the previous cache on failure; subscribers stay on last good data.
    })
    .finally(() => {
      pending = null
    })
}

// Slugs already prefetched at a given version, so we never re-warm the same
// slug:version twice (and a new mtime after an edit warms exactly once more).
const prefetched = new Set<string>()

/**
 * Fire-and-forget warm-up of every custom-tool renderer that ships one. For each
 * `hasRenderer` entry it primes the SAME shared lazy cache used by the chat (via
 * CustomToolRenderer.prefetchRenderer) AND triggers the underlying module import,
 * so by the time a tool-call streams in, its renderer module + the shared lazy are
 * already warm → instant render, no Suspense spinner flash.
 *
 * Non-blocking, best-effort, deduped by `slug:version`. The dynamic import of
 * CustomToolRenderer breaks what would otherwise be a static import cycle.
 */
export function prefetchCustomToolRenderers(): void {
  if (!cache) return
  const targets: Array<{ slug: string; version: number }> = []
  for (const [toolName, entry] of Object.entries(cache)) {
    if (!entry.hasRenderer || entry.rendererVersion === null) continue
    const slug = toolName.startsWith('custom_') ? toolName.slice('custom_'.length) : toolName
    const key = `${slug}:${entry.rendererVersion}`
    if (prefetched.has(key)) continue
    prefetched.add(key)
    targets.push({ slug, version: entry.rendererVersion })
  }
  if (targets.length === 0) return
  void import('@/client/components/chat/CustomToolRenderer')
    .then((m) => {
      for (const { slug, version } of targets) m.prefetchRenderer(slug, version)
    })
    .catch(() => {
      // Swallow: prefetch is a pure optimization; the chat still loads renderers
      // lazily on demand if this fails.
    })
}

/**
 * Reactive lookup of a custom tool's UI metadata. Re-renders the calling
 * component when the cache hydrates/refreshes (so a session-new tool or a newly
 * added renderer appears). While cold the cache load is kicked off; on a miss
 * (cache loaded but key absent) a single background refetch is triggered.
 */
export function useCustomToolMeta(toolName: string): ToolMeta {
  const snap = useSyncExternalStore(
    subscribe,
    () => {
      if (!cache) {
        // Cold: kick off the initial load, return the stable COLD snapshot.
        void loadCustomToolNames()
      } else if (!cache[toolName] && !missAttempted.has(toolName)) {
        // Loaded but absent: trigger ONE background refetch for this key. A tool
        // created after boot will then appear. Deduped so a genuinely-absent key
        // can't cause a refetch storm.
        missAttempted.add(toolName)
        refetch()
      }
      return getSnapshot(toolName)
    },
    () => getSnapshot(toolName),
  )
  return snap
}

/**
 * Force-clear the cache (+ miss tracking) and reload, emitting on success.
 * Called after a custom tool is created/edited/deleted from the Settings modal
 * so any open conversation reflects the change immediately — including a renderer
 * added to an already-cached tool (which the refetch-on-miss path can't catch).
 */
export function refreshCustomToolNames(): void {
  cache = null
  missAttempted.clear()
  // Cache is now cold → loadCustomToolNames() will refetch and emit. emit() runs
  // even on the cleared-but-not-yet-reloaded state so subscribers drop stale data.
  emit()
  void loadCustomToolNames()
}

/**
 * Sync lookup of a custom tool's localized display name. Returns `null` when the
 * cache is cold or the name is unknown (kicks off the load for next render), so
 * callers can fall back to their existing `t('tools.names.<name>', …)` default.
 */
export function getCustomToolName(toolName: string): string | null {
  if (!cache) {
    void loadCustomToolNames()
    return null
  }
  return cache[toolName]?.name ?? null
}

/**
 * Sync lookup of whether a custom tool ships a result renderer. Returns `false`
 * when the cache is cold or the tool is unknown (kicks off the load for next
 * render). A `false` result simply means the default JSON viewer is used.
 */
export function getCustomToolHasRenderer(toolName: string): boolean {
  if (!cache) {
    void loadCustomToolNames()
    return false
  }
  return cache[toolName]?.hasRenderer ?? false
}

/** Test-only: reset internal state. */
export function _resetCustomToolNameCache(): void {
  cache = null
  pending = null
  missAttempted.clear()
  snapshots.clear()
  listeners.clear()
  prefetched.clear()
}
