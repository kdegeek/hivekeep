/**
 * Legacy provider dispatcher — adapter on top of the native LLMProvider
 * abstraction in src/server/llm/. Kept so the few remaining callers
 * (routes/providers, tools/provider-tools, image-tools, model-info-cache,
 * image-generation, routes/kins, llm/core/resolve) don't all need to migrate
 * in lockstep.
 *
 * Built-in provider types (anthropic, anthropic-oauth, openai, openai-codex)
 * are dispatched to the new LLM/Embedding/Image registries; only unknown
 * types fall through to the plugin registry which still uses the
 * `ProviderDefinition` shape (LegacyProviderDefinition).
 */

import type { ProviderDefinition, ProviderConfig, ProviderModel } from '@/server/providers/types'
import type { ProviderCapability } from '@/shared/types'
import { PROVIDER_META, type ProviderType, type ProviderMeta } from '@/shared/provider-metadata'
import { createLogger } from '@/server/logger'
import { getLLMProvider, listLLMProviders } from '@/server/llm/llm/registry'
import { getEmbeddingProvider, listEmbeddingProviders } from '@/server/llm/embedding/registry'
import { getImageProvider, listImageProviders } from '@/server/llm/image/registry'
import type { ProviderConfig as KinbotProviderConfig } from '@/server/llm/core/types'

const log = createLogger('providers')

// ─── Plugin registry (still on the legacy ProviderDefinition shape) ──────────

const pluginRegistry: Record<string, ProviderDefinition> = {}
const pluginProviderMeta: Record<string, ProviderMeta> = {}

export function registerPluginProvider(type: string, definition: ProviderDefinition, meta: ProviderMeta): void {
  if (PROVIDER_META[type as ProviderType]) {
    throw new Error(`Cannot override built-in provider "${type}"`)
  }
  pluginRegistry[type] = definition
  pluginProviderMeta[type] = meta
  log.info({ type, displayName: meta.displayName }, 'Plugin provider registered')
}

export function unregisterPluginProvider(type: string): void {
  delete pluginRegistry[type]
  delete pluginProviderMeta[type]
  log.info({ type }, 'Plugin provider unregistered')
}

export function getPluginProviderMeta(): Record<string, ProviderMeta> {
  return { ...pluginProviderMeta }
}

export function getProviderDefinition(type: string): ProviderDefinition | undefined {
  return pluginRegistry[type]
}

export function getCapabilitiesForType(type: string): ProviderCapability[] {
  return [...(PROVIDER_META[type as ProviderType]?.capabilities ?? pluginProviderMeta[type]?.capabilities ?? [])]
}

// ─── Dispatcher helpers ──────────────────────────────────────────────────────

function asKinbotConfig(config: ProviderConfig): KinbotProviderConfig {
  // The legacy ProviderConfig is `{ apiKey, baseUrl? }`; the native shape is
  // `Record<string, string | undefined>`. Compatible in practice.
  return config as unknown as KinbotProviderConfig
}

/**
 * Look up a built-in provider across the three native registries and run
 * `fn` against the first match. Returns null when the type is unknown to all
 * three registries (caller falls back to plugins).
 */
async function tryDispatch<T>(
  type: string,
  config: ProviderConfig,
  fn: {
    llm: (p: ReturnType<typeof getLLMProvider> extends infer X ? Exclude<X, undefined> : never) => Promise<T>
    embedding: (p: ReturnType<typeof getEmbeddingProvider> extends infer X ? Exclude<X, undefined> : never) => Promise<T>
    image: (p: ReturnType<typeof getImageProvider> extends infer X ? Exclude<X, undefined> : never) => Promise<T>
  },
): Promise<T | null> {
  void config
  const llm = getLLMProvider(type)
  if (llm) return fn.llm(llm)
  const emb = getEmbeddingProvider(type)
  if (emb) return fn.embedding(emb)
  const img = getImageProvider(type)
  if (img) return fn.image(img)
  return null
}

// ─── Public API used by the rest of the codebase ─────────────────────────────

export async function testProviderConnection(
  type: string,
  config: ProviderConfig,
): Promise<{ valid: boolean; capabilities: string[]; error?: string }> {
  // In E2E test mode, skip real provider connection tests
  if (process.env.E2E_SKIP_PROVIDER_TEST === 'true') {
    const capabilities = getCapabilitiesForType(type)
    log.info({ type, capabilities }, 'E2E mode: skipping real provider test')
    return { valid: true, capabilities }
  }

  const cfg = asKinbotConfig(config)
  const result = await tryDispatch<{ valid: boolean; error?: string }>(type, config, {
    llm: (p) => p.authenticate(cfg).then((r) => ({ valid: r.valid, error: r.error })),
    embedding: (p) => p.authenticate(cfg).then((r) => ({ valid: r.valid, error: r.error })),
    image: (p) => p.authenticate(cfg).then((r) => ({ valid: r.valid, error: r.error })),
  })

  if (result) {
    log.info({ type, valid: result.valid, error: result.error }, 'Provider connection tested')
    return {
      valid: result.valid,
      capabilities: result.valid ? getCapabilitiesForType(type) : [],
      error: result.error,
    }
  }

  // Fall back to legacy plugin definition.
  const definition = pluginRegistry[type]
  if (!definition) {
    log.error({ type }, 'Unknown provider type')
    return { valid: false, capabilities: [], error: `Unknown provider type: ${type}` }
  }

  const legacy = await definition.testConnection(config)
  log.info({ type, valid: legacy.valid, error: legacy.error }, 'Plugin provider connection tested')
  return {
    valid: legacy.valid,
    capabilities: legacy.valid ? getCapabilitiesForType(type) : [],
    error: legacy.error,
  }
}

export async function listModelsForProvider(
  type: string,
  config: ProviderConfig,
): Promise<ProviderModel[]> {
  log.debug({ type }, 'Listing models for provider')

  const cfg = asKinbotConfig(config)
  const models = await tryDispatch<ProviderModel[]>(type, config, {
    llm: async (p) => {
      const list = await p.listModels(cfg)
      return list.map((m): ProviderModel => ({
        id: m.id,
        name: m.name,
        capability: 'llm',
        ...(m.supportsImageInput ? { supportsImageInput: true } : {}),
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        ...(m.maxOutput != null ? { maxOutput: m.maxOutput } : {}),
      }))
    },
    embedding: async (p) => {
      const list = await p.listModels(cfg)
      return list.map((m): ProviderModel => ({
        id: m.id,
        name: m.name,
        capability: 'embedding',
        ...(m.maxInputTokens ? { contextWindow: m.maxInputTokens } : {}),
      }))
    },
    image: async (p) => {
      const list = await p.listModels(cfg)
      return list.map((m): ProviderModel => ({
        id: m.id,
        name: m.name,
        capability: 'image',
        ...(m.supportsImageInput ? { supportsImageInput: true } : {}),
      }))
    },
  })

  if (models) {
    if (models.length > 0) {
      // Auto-populate the model-info cache so callers of getModelContextWindow()
      // get accurate values straight from the provider's API. Lazy import to
      // avoid a circular dependency at module load.
      const { populateFromProviderModels } = await import('@/server/services/model-info-cache')
      populateFromProviderModels(models)
    }
    return models
  }

  // Fall back to legacy plugin.
  const definition = pluginRegistry[type]
  if (!definition) {
    log.error({ type }, 'Cannot list models for unknown provider type')
    return []
  }
  const list = await definition.listModels(config)
  if (list.length > 0) {
    const { populateFromProviderModels } = await import('@/server/services/model-info-cache')
    populateFromProviderModels(list)
  }
  return list
}

/** For diagnostics — counts of providers registered in each registry. */
export function getRegistryStats() {
  return {
    llm: listLLMProviders().map((p) => p.type),
    embedding: listEmbeddingProviders().map((p) => p.type),
    image: listImageProviders().map((p) => p.type),
    plugins: Object.keys(pluginRegistry),
  }
}
