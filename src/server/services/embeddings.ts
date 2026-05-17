import OpenAI from 'openai'
import { db } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import { providers } from '@/server/db/schema'
import { config } from '@/server/config'
import { getEmbeddingModel } from '@/server/services/app-settings'
import { decrypt } from '@/server/services/encryption'
import { recordUsage } from '@/server/services/token-usage'

const log = createLogger('embeddings')

/**
 * Generate embeddings for a text string using the configured embedding provider.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const provider = await findEmbeddingProvider()
  if (!provider) {
    log.warn('No embedding provider configured')
    throw new Error('No embedding provider configured')
  }

  const providerConfig = JSON.parse(await decrypt(provider.configEncrypted)) as {
    apiKey: string
  }

  const embeddingModelId = (await getEmbeddingModel()) ?? config.memory.embeddingModel

  if (provider.type !== 'openai') {
    throw new Error(`Provider type ${provider.type} does not support embeddings`)
  }

  const openai = new OpenAI({ apiKey: providerConfig.apiKey })
  const result = await openai.embeddings.create({
    model: embeddingModelId,
    input: text,
  })

  const vector = result.data[0]?.embedding
  if (!vector) throw new Error('OpenAI embeddings API returned no vector')

  recordUsage({
    callSite: 'embedding',
    callType: 'embed',
    providerType: provider.type,
    providerId: provider.id,
    modelId: embeddingModelId,
    embeddingTokens: result.usage?.prompt_tokens,
  })

  return vector
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
