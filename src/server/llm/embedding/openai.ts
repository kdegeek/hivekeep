/**
 * OpenAI embeddings provider — wraps `openai.embeddings.create()`.
 */

import OpenAI, { APIError } from 'openai'
import type {
  ConfigField,
  ProviderConfig,
  AuthResult,
} from '@/server/llm/core/types'
import {
  AuthError,
  RateLimitError,
  InvalidRequestError,
  NetworkError,
  ProviderServerError,
  HivekeepProviderError,
} from '@/server/llm/core/types'
import type {
  EmbeddingProvider,
  EmbeddingModel,
  EmbedRequest,
  EmbedResult,
} from '@/server/llm/embedding/types'

const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: 'apiKey',
    type: 'secret',
    label: 'API Key',
    required: true,
    placeholder: 'sk-…',
    description: 'OpenAI API key used for embeddings.',
  },
]

/** Known OpenAI embedding models with their dimensions + max input. */
const KNOWN_MODELS: EmbeddingModel[] = [
  {
    id: 'text-embedding-3-small',
    name: 'text-embedding-3-small',
    dimensions: 1536,
    maxInputTokens: 8191,
  },
  {
    id: 'text-embedding-3-large',
    name: 'text-embedding-3-large',
    dimensions: 3072,
    maxInputTokens: 8191,
  },
  {
    id: 'text-embedding-ada-002',
    name: 'text-embedding-ada-002',
    dimensions: 1536,
    maxInputTokens: 8191,
  },
]

function createClient(config: ProviderConfig): OpenAI {
  const apiKey = config['apiKey']
  if (!apiKey) throw new AuthError('Missing OpenAI API key')
  return new OpenAI({ apiKey })
}

function mapApiError(err: unknown): HivekeepProviderError {
  if (err instanceof HivekeepProviderError) return err
  if (err instanceof APIError) {
    const status = err.status
    const message = err.message
    if (status === 401 || status === 403) return new AuthError(message, err)
    if (status === 429) return new RateLimitError(message, undefined, err)
    if (status && status >= 400 && status < 500) return new InvalidRequestError(message, err)
    if (status && status >= 500) return new ProviderServerError(message, status, err)
    return new ProviderServerError(message, status, err)
  }
  if (err instanceof Error) return new NetworkError(err.message, err)
  return new NetworkError(String(err))
}

function isEmbeddingModelId(id: string): boolean {
  return id.startsWith('text-embedding')
}

export const openaiEmbeddingProvider: EmbeddingProvider = {
  type: 'openai',
  displayName: 'OpenAI (Embeddings)',
  configSchema: CONFIG_SCHEMA,

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    try {
      const client = createClient(config)
      await client.models.list()
      return { valid: true }
    } catch (err) {
      return { valid: false, error: mapApiError(err).message }
    }
  },

  async listModels(config: ProviderConfig): Promise<EmbeddingModel[]> {
    const client = createClient(config)
    try {
      const page = await client.models.list()
      const seen = new Set<string>()
      const out: EmbeddingModel[] = []
      for (const m of page.data) {
        if (!isEmbeddingModelId(m.id)) continue
        if (seen.has(m.id)) continue
        seen.add(m.id)
        const known = KNOWN_MODELS.find((k) => k.id === m.id)
        out.push(known ?? { id: m.id, name: m.id, dimensions: 1536, maxInputTokens: 8191 })
      }
      // Make sure known models are always listed even when /v1/models
      // returns nothing useful (some account types restrict it).
      for (const k of KNOWN_MODELS) {
        if (!seen.has(k.id)) out.push(k)
      }
      return out
    } catch (err) {
      throw mapApiError(err)
    }
  },

  async embed(
    model: EmbeddingModel,
    request: EmbedRequest,
    config: ProviderConfig,
  ): Promise<EmbedResult> {
    const client = createClient(config)
    try {
      const result = await client.embeddings.create({
        model: model.id,
        input: request.text,
      }, { signal: request.signal })
      const vector = result.data[0]?.embedding
      if (!vector) {
        throw new ProviderServerError('OpenAI embeddings API returned no vector')
      }
      return { vector, inputTokens: result.usage?.prompt_tokens }
    } catch (err) {
      throw mapApiError(err)
    }
  },
}
