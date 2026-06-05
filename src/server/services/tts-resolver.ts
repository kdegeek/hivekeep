/**
 * TTS provider resolver — single resolution path used by `text_to_speech`
 * and `list_tts_providers` to decide which TTS provider answers a
 * given call.
 *
 * Resolution order:
 *   1. Explicit `slug` argument — exact match against `providers.slug`.
 *   2. Global default (`default_tts_provider_id` in app_settings) when
 *      the row still exists, is valid, and carries the `tts` capability.
 *   3. First valid provider row with capability `tts` (deterministic
 *      tie-break: DB scan order; first hit wins).
 *
 * Mirror of `search-resolver.ts` — error codes and shape are identical
 * so callers can share the mapping pattern.
 */

import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { providers as providersTable } from '@/server/db/schema'
import { getDefaultTtsProviderId } from '@/server/services/app-settings'
import { loadProviderConfig } from '@/server/services/provider-config'
import { getTTSProvider } from '@/server/llm/tts/registry'
import type { TTSProvider } from '@/server/llm/tts/types'
import type { ProviderConfig } from '@/server/llm/core/types'
import { createLogger } from '@/server/logger'

const log = createLogger('tts-resolver')

type ProviderRow = typeof providersTable.$inferSelect

export interface ResolvedTTSProvider {
  row: ProviderRow
  config: ProviderConfig
  provider: TTSProvider
}

export type TTSResolveErrorCode =
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_NOT_TTS'
  | 'PROVIDER_INVALID'
  | 'PROVIDER_PLUGIN_NOT_LOADED'
  | 'NO_TTS_PROVIDER_CONFIGURED'

export class TTSResolveError extends Error {
  constructor(
    public readonly code: TTSResolveErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'TTSResolveError'
  }
}

function rowHasTtsCapability(row: ProviderRow): boolean {
  try {
    const caps = JSON.parse(row.capabilities) as string[]
    return caps.includes('tts')
  } catch {
    return false
  }
}

async function loadFromRow(row: ProviderRow): Promise<ResolvedTTSProvider> {
  const provider = getTTSProvider(row.type)
  if (!provider) {
    throw new TTSResolveError(
      'PROVIDER_PLUGIN_NOT_LOADED',
      `TTS provider type "${row.type}" is not currently loaded (the contributing plugin may be disabled or uninstalled).`,
    )
  }
  const cfg = await loadProviderConfig(row)
  return { row, config: cfg, provider }
}

export async function resolveTtsProvider(slug?: string): Promise<ResolvedTTSProvider> {
  if (slug) {
    const row = db.select().from(providersTable).where(eq(providersTable.slug, slug)).get()
    if (!row) {
      throw new TTSResolveError(
        'PROVIDER_NOT_FOUND',
        `No provider with slug "${slug}". Call list_tts_providers to see what's configured.`,
      )
    }
    if (!rowHasTtsCapability(row)) {
      throw new TTSResolveError(
        'PROVIDER_NOT_TTS',
        `Provider "${slug}" is not a TTS provider (capabilities: ${row.capabilities}).`,
      )
    }
    if (!row.isValid) {
      throw new TTSResolveError(
        'PROVIDER_INVALID',
        `Provider "${slug}" is marked invalid: ${row.lastError ?? 'no error recorded'}.`,
      )
    }
    return loadFromRow(row)
  }

  const defaultId = await getDefaultTtsProviderId()
  if (defaultId) {
    const row = db.select().from(providersTable).where(eq(providersTable.id, defaultId)).get()
    if (row && row.isValid && rowHasTtsCapability(row)) {
      return loadFromRow(row)
    }
    log.warn(
      { defaultId, exists: !!row, isValid: row?.isValid, hasTts: row ? rowHasTtsCapability(row) : false },
      'Default TTS provider is unresolvable — falling back to first valid',
    )
  }

  const all = db.select().from(providersTable).all()
  for (const row of all) {
    if (!row.isValid) continue
    if (!rowHasTtsCapability(row)) continue
    return loadFromRow(row)
  }

  throw new TTSResolveError(
    'NO_TTS_PROVIDER_CONFIGURED',
    'No TTS provider is configured. Add one in Settings → Providers before using text_to_speech.',
  )
}
