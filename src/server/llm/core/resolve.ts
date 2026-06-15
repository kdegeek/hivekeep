/**
 * Resolve a (modelId, providerId?) reference to a concrete provider + model +
 * decrypted config triple, ready to be passed to `provider.chat()`.
 *
 * This is the hivekeep-side dispatcher: the rest of the codebase only knows
 * about model IDs and provider rows in DB; this helper hides the lookup,
 * decryption, and model-info fetching from every caller.
 */

import { eq, or } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { providers } from '@/server/db/schema'
import { loadProviderConfig } from '@/server/services/provider-config'
import { getLLMProvider } from '@/server/llm/llm/registry'
import { listModelsForProvider } from '@/server/providers/index'
import { providerPriority } from '@/server/llm/core/provider-priority'
import { enrichModel } from '@/server/llm/metadata/enrich'
import type { LLMProvider, LLMModel } from '@/server/llm/llm/types'
import type { ProviderConfig } from '@/server/llm/core/types'
import { AuthError, InvalidRequestError } from '@/server/llm/core/types'

export interface ResolvedLLM {
  provider: LLMProvider
  model: LLMModel
  config: ProviderConfig
  /** The provider row from DB — exposed so callers can attribute usage. */
  providerRow: typeof providers.$inferSelect
}

interface ResolveOptions {
  modelId: string
  /** Restrict the search to this specific provider. Accepts either the
   *  provider's UUID (`providers.id`) or its stable slug (`providers.slug`,
   *  e.g. "openai-codex"). When omitted, the resolver scans every valid
   *  LLM provider in subscription-first order. */
  providerId?: string | null
}

async function readProviderConfig(
  row: typeof providers.$inferSelect,
): Promise<ProviderConfig> {
  // Delegates to the shared chokepoint: decrypt + parse + hydrate $vault: refs.
  return loadProviderConfig(row)
}

async function findModelInProvider(
  llmProvider: LLMProvider,
  config: ProviderConfig,
  modelId: string,
): Promise<LLMModel | undefined> {
  const list = await llmProvider.listModels(config)
  return list.find((m) => m.id === modelId)
}

/**
 * Resolve an LLM call target. Tries the preferred provider first when given,
 * then falls back to the first LLM provider that exposes the model.
 *
 * Throws `InvalidRequestError` when the model can't be resolved on any valid
 * provider, `AuthError` when the only candidate is invalid.
 */
export async function resolveLLM(opts: ResolveOptions): Promise<ResolvedLLM> {
  const { modelId, providerId } = opts

  // Preferred provider path. Accept UUID or slug — Agents prefer the slug
  // because it's stable across renames and far easier to express in a tool call.
  if (providerId) {
    const row = db
      .select()
      .from(providers)
      .where(or(eq(providers.id, providerId), eq(providers.slug, providerId)))
      .get()
    if (!row) {
      throw new InvalidRequestError(
        `Provider not found: "${providerId}". ` +
          `Expected a provider slug (e.g. "openai-codex") or UUID — use list_providers ` +
          `(or list_models for a model→provider mapping) to discover valid IDs.`,
      )
    }
    if (!row.isValid) throw new AuthError(`Provider ${providerId} is not valid`)
    const llm = getLLMProvider(row.type)
    if (!llm) throw new InvalidRequestError(`No LLM implementation for provider type "${row.type}"`)
    const config = await readProviderConfig(row)
    const model = await findModelInProvider(llm, config, modelId)
    if (!model) throw new InvalidRequestError(`Model "${modelId}" not available on provider ${providerId} (${row.type})`)
    return { provider: llm, model: enrichModel(row.id, row.type, model), config, providerRow: row }
  }

  // Auto-resolve: scan valid LLM providers. Order matters when the same
  // model name is served by several providers (e.g. an OpenAI API key AND
  // an OpenAI Codex CLI subscription both expose `gpt-5`) — without an
  // explicit `providerId`, the user almost certainly wants the
  // fixed-cost subscription rather than pay-per-token. Sort accordingly:
  // subscription-style providers first, then API-key providers, then
  // plugins, then anything else.
  const allRows = db.select().from(providers).all()
  const sorted = [...allRows].sort((a, b) => providerPriority(a.type) - providerPriority(b.type))
  for (const row of sorted) {
    if (!row.isValid) continue
    const llm = getLLMProvider(row.type)
    if (!llm) continue
    try {
      const config = await readProviderConfig(row)
      const model = await findModelInProvider(llm, config, modelId)
      if (model) return { provider: llm, model: enrichModel(row.id, row.type, model), config, providerRow: row }
    } catch {
      // This provider can't serve the model — keep scanning.
    }
  }
  throw new InvalidRequestError(
    `Model "${modelId}" not available on any configured provider. ` +
      `Use list_models to discover valid (model, provider) pairs.`,
  )
}


/**
 * Pick a usable LLM model for one-shot helpers (avatar/icon prompts, wizard
 * config generation, mini-app capabilities) that just want "something that
 * works".
 *
 * Prefers the platform's configured default LLM (chat) model — the model the
 * operator actually picked and has access to. Only when no default is set (or
 * it no longer resolves) does it fall back to scanning providers and taking
 * the first model each one lists. That blind scan is dangerous on its own:
 * provider APIs list newest-first (Anthropic's `models.list` puts the latest
 * release at the top), so `list[0]` can be a brand-new model the account isn't
 * entitled to yet — which only surfaces as a 404 at call time, not in the list.
 */
export async function pickAnyLLMModel(): Promise<ResolvedLLM | null> {
  const { getDefaultLlmModel, getDefaultLlmProviderId } = await import('@/server/services/app-settings')
  const defaultModel = await getDefaultLlmModel()
  if (defaultModel) {
    try {
      const defaultProviderId = await getDefaultLlmProviderId()
      return await resolveLLM({ modelId: defaultModel, providerId: defaultProviderId })
    } catch {
      // The configured default points at a model/provider that's gone or
      // invalid — fall through to the first-available scan below.
    }
  }

  const allRows = db.select().from(providers).all()
  for (const row of allRows) {
    if (!row.isValid) continue
    const llm = getLLMProvider(row.type)
    if (!llm) continue
    try {
      const config = await readProviderConfig(row)
      const list = await llm.listModels(config)
      const first = list[0]
      if (first) return { provider: llm, model: enrichModel(row.id, row.type, first), config, providerRow: row }
    } catch {
      // Skip this provider
    }
  }
  return null
}
