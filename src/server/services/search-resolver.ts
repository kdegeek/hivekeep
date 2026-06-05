/**
 * Search provider resolver — single resolution path used by `web_search`
 * and `list_search_providers` to decide which search provider answers
 * a given call.
 *
 * Resolution order:
 *   1. Explicit `slug` argument — exact match against `providers.slug`.
 *   2. Global default (`default_search_provider_id` in app_settings) when
 *      the row still exists, is valid, and carries the `search` capability.
 *   3. First valid provider row with capability `search` (deterministic
 *      tie-break: ordered by createdAt ASC via DB scan order; first hit
 *      wins).
 *
 * The resolver returns the DB row, the decrypted config, and the live
 * `SearchProvider` instance from the registry — callers never need to
 * touch the registry or decrypt secrets themselves.
 *
 * Errors are typed (`SearchResolveError` with a stable `code`) so the
 * `web_search` tool can map them to clean LLM-facing messages without
 * sniffing strings.
 */

import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { providers as providersTable } from '@/server/db/schema'
import { loadProviderConfig } from '@/server/services/provider-config'
import { getDefaultSearchProviderId } from '@/server/services/app-settings'
import { getSearchProvider } from '@/server/llm/search/registry'
import type { SearchProvider } from '@/server/llm/search/types'
import type { ProviderConfig } from '@/server/llm/core/types'
import { createLogger } from '@/server/logger'

const log = createLogger('search-resolver')

type ProviderRow = typeof providersTable.$inferSelect

export interface ResolvedSearchProvider {
  row: ProviderRow
  config: ProviderConfig
  provider: SearchProvider
}

export type SearchResolveErrorCode =
  | 'PROVIDER_NOT_FOUND'           // explicit slug doesn't match any row
  | 'PROVIDER_NOT_SEARCH'          // row exists but isn't a search provider
  | 'PROVIDER_INVALID'             // row marked invalid (auth/credentials)
  | 'PROVIDER_PLUGIN_NOT_LOADED'   // plugin-contributed type no longer registered
  | 'NO_SEARCH_PROVIDER_CONFIGURED' // nothing resolvable anywhere

export class SearchResolveError extends Error {
  constructor(
    public readonly code: SearchResolveErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SearchResolveError'
  }
}

function rowHasSearchCapability(row: ProviderRow): boolean {
  try {
    const caps = JSON.parse(row.capabilities) as string[]
    return caps.includes('search')
  } catch {
    return false
  }
}

async function loadFromRow(row: ProviderRow): Promise<ResolvedSearchProvider> {
  const provider = getSearchProvider(row.type)
  if (!provider) {
    throw new SearchResolveError(
      'PROVIDER_PLUGIN_NOT_LOADED',
      `Search provider type "${row.type}" is not currently loaded (the contributing plugin may be disabled or uninstalled).`,
    )
  }
  const cfg = await loadProviderConfig(row)
  return { row, config: cfg, provider }
}

/**
 * Resolve a search provider for a tool call.
 *
 * @param slug - Explicit provider slug from the tool input. When omitted,
 *               falls back to the global default, then to the first valid
 *               search provider.
 */
export async function resolveSearchProvider(slug?: string): Promise<ResolvedSearchProvider> {
  // 1. Explicit slug — strict match on a single row.
  if (slug) {
    const row = db.select().from(providersTable).where(eq(providersTable.slug, slug)).get()
    if (!row) {
      throw new SearchResolveError(
        'PROVIDER_NOT_FOUND',
        `No provider with slug "${slug}". Call list_search_providers to see what's configured.`,
      )
    }
    if (!rowHasSearchCapability(row)) {
      throw new SearchResolveError(
        'PROVIDER_NOT_SEARCH',
        `Provider "${slug}" is not a search provider (capabilities: ${row.capabilities}).`,
      )
    }
    if (!row.isValid) {
      throw new SearchResolveError(
        'PROVIDER_INVALID',
        `Provider "${slug}" is marked invalid: ${row.lastError ?? 'no error recorded'}.`,
      )
    }
    return loadFromRow(row)
  }

  // 2. Global default — only honored when the row still resolves cleanly.
  const defaultId = await getDefaultSearchProviderId()
  if (defaultId) {
    const row = db.select().from(providersTable).where(eq(providersTable.id, defaultId)).get()
    if (row && row.isValid && rowHasSearchCapability(row)) {
      return loadFromRow(row)
    }
    log.warn(
      { defaultId, exists: !!row, isValid: row?.isValid, hasSearch: row ? rowHasSearchCapability(row) : false },
      'Default search provider is unresolvable — falling back to first valid',
    )
  }

  // 3. First valid search provider (deterministic by DB scan order).
  const all = db.select().from(providersTable).all()
  for (const row of all) {
    if (!row.isValid) continue
    if (!rowHasSearchCapability(row)) continue
    return loadFromRow(row)
  }

  throw new SearchResolveError(
    'NO_SEARCH_PROVIDER_CONFIGURED',
    'No search provider is configured. Add one in Settings → Providers before using web_search.',
  )
}
