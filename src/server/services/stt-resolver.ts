/**
 * STT provider resolver — single resolution path used by
 * `transcribe_audio` and `list_stt_providers` to decide which STT
 * provider answers a given call.
 *
 * Resolution order:
 *   1. Explicit `slug` argument — exact match against `providers.slug`.
 *   2. Global default (`default_stt_provider_id` in app_settings) when
 *      the row still exists, is valid, and carries the `stt` capability.
 *   3. First valid provider row with capability `stt`.
 *
 * Mirror of `tts-resolver.ts` / `search-resolver.ts` — identical
 * shape so callers can share the mapping pattern.
 */

import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { providers as providersTable } from '@/server/db/schema'
import { loadProviderConfig } from '@/server/services/provider-config'
import { getDefaultSttProviderId } from '@/server/services/app-settings'
import { getSTTProvider } from '@/server/llm/stt/registry'
import type { STTProvider } from '@/server/llm/stt/types'
import type { ProviderConfig } from '@/server/llm/core/types'
import { createLogger } from '@/server/logger'

const log = createLogger('stt-resolver')

type ProviderRow = typeof providersTable.$inferSelect

export interface ResolvedSTTProvider {
  row: ProviderRow
  config: ProviderConfig
  provider: STTProvider
}

export type STTResolveErrorCode =
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_NOT_STT'
  | 'PROVIDER_INVALID'
  | 'PROVIDER_PLUGIN_NOT_LOADED'
  | 'NO_STT_PROVIDER_CONFIGURED'

export class STTResolveError extends Error {
  constructor(
    public readonly code: STTResolveErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'STTResolveError'
  }
}

function rowHasSttCapability(row: ProviderRow): boolean {
  try {
    const caps = JSON.parse(row.capabilities) as string[]
    return caps.includes('stt')
  } catch {
    return false
  }
}

async function loadFromRow(row: ProviderRow): Promise<ResolvedSTTProvider> {
  const provider = getSTTProvider(row.type)
  if (!provider) {
    throw new STTResolveError(
      'PROVIDER_PLUGIN_NOT_LOADED',
      `STT provider type "${row.type}" is not currently loaded (the contributing plugin may be disabled or uninstalled).`,
    )
  }
  const cfg = await loadProviderConfig(row)
  return { row, config: cfg, provider }
}

export async function resolveSttProvider(slug?: string): Promise<ResolvedSTTProvider> {
  if (slug) {
    const row = db.select().from(providersTable).where(eq(providersTable.slug, slug)).get()
    if (!row) {
      throw new STTResolveError(
        'PROVIDER_NOT_FOUND',
        `No provider with slug "${slug}". Call list_stt_providers to see what's configured.`,
      )
    }
    if (!rowHasSttCapability(row)) {
      throw new STTResolveError(
        'PROVIDER_NOT_STT',
        `Provider "${slug}" is not an STT provider (capabilities: ${row.capabilities}).`,
      )
    }
    if (!row.isValid) {
      throw new STTResolveError(
        'PROVIDER_INVALID',
        `Provider "${slug}" is marked invalid: ${row.lastError ?? 'no error recorded'}.`,
      )
    }
    return loadFromRow(row)
  }

  const defaultId = await getDefaultSttProviderId()
  if (defaultId) {
    const row = db.select().from(providersTable).where(eq(providersTable.id, defaultId)).get()
    if (row && row.isValid && rowHasSttCapability(row)) {
      return loadFromRow(row)
    }
    log.warn(
      { defaultId, exists: !!row, isValid: row?.isValid, hasStt: row ? rowHasSttCapability(row) : false },
      'Default STT provider is unresolvable — falling back to first valid',
    )
  }

  const all = db.select().from(providersTable).all()
  for (const row of all) {
    if (!row.isValid) continue
    if (!rowHasSttCapability(row)) continue
    return loadFromRow(row)
  }

  throw new STTResolveError(
    'NO_STT_PROVIDER_CONFIGURED',
    'No STT provider is configured. Add one in Settings → Providers before using transcribe_audio.',
  )
}
