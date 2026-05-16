import { api } from '@/client/lib/api'
import type { ToolDomain } from '@/shared/types'

/**
 * Client-side cache of the registry's name → domain map.
 *
 * The server is the single source of truth (each tool declares its
 * domain at registration in `src/server/tools/register.ts`). The client
 * fetches the full snapshot once on app boot and uses a sync accessor
 * everywhere else. While the fetch is in-flight the accessor falls back
 * to `'mcp'` so the UI keeps rendering — first paint of a new tool may
 * briefly show the generic MCP badge, which is acceptable.
 */
let cache: Record<string, ToolDomain> | null = null
let pending: Promise<void> | null = null

export async function loadToolDomainMap(): Promise<void> {
  if (cache) return
  if (pending) return pending
  pending = api
    .get<Record<string, ToolDomain>>('/tools/domains')
    .then((map) => {
      cache = map
    })
    .catch(() => {
      // Leave cache null so subsequent calls will retry. Falling back to
      // 'mcp' for tool-call badges is graceful — the page still works.
    })
    .finally(() => {
      pending = null
    })
  return pending
}

/** Sync lookup. Returns `'mcp'` when the cache hasn't loaded yet. */
export function getToolDomain(name: string): ToolDomain {
  if (!cache) {
    // Kick off the load so a subsequent render gets the real value.
    void loadToolDomainMap()
    return 'mcp'
  }
  return cache[name] ?? 'mcp'
}

/** Snapshot of the cached map. Returns `{}` while loading. Used by callers
 *  that need to iterate the whole map (e.g. the AI-suggestion flow that
 *  expands a list of domains into a list of tool names). */
export function getToolDomainMap(): Record<string, ToolDomain> {
  if (!cache) {
    void loadToolDomainMap()
    return {}
  }
  return cache
}

/** Test-only: reset internal state. */
export function _resetToolDomainCache(): void {
  cache = null
  pending = null
}
