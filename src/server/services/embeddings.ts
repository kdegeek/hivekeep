import { db } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import { providers } from '@/server/db/schema'
import { config } from '@/server/config'
import { getEmbeddingModel } from '@/server/services/app-settings'
import { loadProviderConfig } from '@/server/services/provider-config'
import { recordUsage } from '@/server/services/token-usage'
import { getEmbeddingProvider } from '@/server/llm/embedding/registry'

const log = createLogger('embeddings')

/**
 * Generate embeddings for a text string using the configured embedding provider.
 *
 * The embedding family is dispatched through the native `EmbeddingProvider`
 * registry. Today only `openai` is registered; adding Voyage / Cohere /
 * Nomic later is a single new provider file + register call away.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const provider = await findEmbeddingProvider()
  if (!provider) {
    log.warn('No embedding provider configured')
    throw new Error('No embedding provider configured')
  }

  const providerConfig = await loadProviderConfig(provider)
  const embeddingModelId = (await getEmbeddingModel()) ?? config.memory.embeddingModel

  const embeddingProvider = getEmbeddingProvider(provider.type)
  if (!embeddingProvider) {
    throw new Error(`Provider type ${provider.type} does not support embeddings`)
  }

  // Pass a minimal model object — concrete dimensions/maxInputTokens aren't
  // used by `embed()` itself (only by callers that want to size/chunk input).
  const result = await embeddingProvider.embed(
    { id: embeddingModelId, name: embeddingModelId, dimensions: 0, maxInputTokens: 0 },
    { text },
    providerConfig,
  )

  recordUsage({
    callSite: 'embedding',
    callType: 'embed',
    providerType: provider.type,
    providerId: provider.id,
    modelId: embeddingModelId,
    embeddingTokens: result.inputTokens,
  })

  return result.vector
}

async function findEmbeddingProvider() {
  const allProviders = await db.select().from(providers).all()

  for (const p of allProviders) {
    try {
      const capabilities = JSON.parse(p.capabilities) as string[]
      if (capabilities.includes('embedding') && p.isValid) {
        return p
      }
    } catch {
      // Skip
    }
  }

  return null
}
