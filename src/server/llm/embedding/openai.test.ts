import { describe, expect, it, mock, beforeEach } from 'bun:test'
import { ProviderServerError } from '@/server/llm/core/types'

const mockModelsList = mock(() => Promise.resolve({ data: [] as Array<{ id: string }> }))
const mockEmbeddingsCreate = mock(() => Promise.resolve({
  data: [{ embedding: [0.1, 0.2, 0.3] }],
  usage: { prompt_tokens: 42 },
}))

mock.module('openai', () => {
  class APIError extends Error {
    status: number
    headers: Record<string, string>
    constructor(status: number, message: string) {
      super(message)
      this.name = 'APIError'
      this.status = status
      this.headers = {}
    }
  }
  function OpenAI(_opts: { apiKey: string }) {
    return {
      models: { list: mockModelsList },
      embeddings: { create: mockEmbeddingsCreate },
    }
  }
  return {
    default: OpenAI,
    APIError,
    toFile: async (data: Uint8Array, name: string, _opts?: { type?: string }) => ({ data, name }),
  }
})

const { openaiEmbeddingProvider } = await import('./openai')

beforeEach(() => {
  mockModelsList.mockReset()
  mockEmbeddingsCreate.mockReset()
  mockModelsList.mockImplementation(() => Promise.resolve({ data: [] }))
  mockEmbeddingsCreate.mockImplementation(() => Promise.resolve({
    data: [{ embedding: [0.1, 0.2, 0.3] }],
    usage: { prompt_tokens: 42 },
  }))
})

// ─── authenticate ────────────────────────────────────────────────────────────

describe('openaiEmbeddingProvider.authenticate', () => {
  it('returns valid:true on a working key', async () => {
    const result = await openaiEmbeddingProvider.authenticate({ apiKey: 'sk-test' })
    expect(result.valid).toBe(true)
  })

  it('returns valid:false when /v1/models throws', async () => {
    mockModelsList.mockImplementation(() => Promise.reject(new Error('boom')))
    const result = await openaiEmbeddingProvider.authenticate({ apiKey: 'sk-test' })
    expect(result.valid).toBe(false)
    expect(result.error).toContain('boom')
  })

  it('returns valid:false when apiKey is missing', async () => {
    const result = await openaiEmbeddingProvider.authenticate({})
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Missing OpenAI API key')
  })
})

// ─── listModels ──────────────────────────────────────────────────────────────

describe('openaiEmbeddingProvider.listModels', () => {
  it('keeps only text-embedding-* IDs from /v1/models', async () => {
    mockModelsList.mockImplementation(() => Promise.resolve({
      data: [
        { id: 'gpt-4o' },
        { id: 'text-embedding-3-small' },
        { id: 'text-embedding-3-large' },
        { id: 'whisper-1' },
      ],
    }))
    const models = await openaiEmbeddingProvider.listModels({ apiKey: 'sk-test' })
    const ids = models.map((m) => m.id)
    expect(ids).toContain('text-embedding-3-small')
    expect(ids).toContain('text-embedding-3-large')
    expect(ids).not.toContain('gpt-4o')
    expect(ids).not.toContain('whisper-1')
  })

  it('returns the static fallback when /v1/models is empty', async () => {
    mockModelsList.mockImplementation(() => Promise.resolve({ data: [] }))
    const models = await openaiEmbeddingProvider.listModels({ apiKey: 'sk-test' })
    const ids = models.map((m) => m.id)
    expect(ids).toContain('text-embedding-3-small')
    expect(ids).toContain('text-embedding-3-large')
    expect(ids).toContain('text-embedding-ada-002')
  })

  it('reports the correct vector dimensions on known models', async () => {
    mockModelsList.mockImplementation(() => Promise.resolve({ data: [] }))
    const models = await openaiEmbeddingProvider.listModels({ apiKey: 'sk-test' })
    const small = models.find((m) => m.id === 'text-embedding-3-small')!
    const large = models.find((m) => m.id === 'text-embedding-3-large')!
    expect(small.dimensions).toBe(1536)
    expect(large.dimensions).toBe(3072)
  })

  it('does not duplicate models present in both /v1/models and the fallback', async () => {
    mockModelsList.mockImplementation(() => Promise.resolve({
      data: [{ id: 'text-embedding-3-small' }],
    }))
    const models = await openaiEmbeddingProvider.listModels({ apiKey: 'sk-test' })
    const matches = models.filter((m) => m.id === 'text-embedding-3-small')
    expect(matches).toHaveLength(1)
  })
})

// ─── embed ───────────────────────────────────────────────────────────────────

describe('openaiEmbeddingProvider.embed', () => {
  it('calls embeddings.create with the right payload', async () => {
    await openaiEmbeddingProvider.embed(
      { id: 'text-embedding-3-small', name: 'small', dimensions: 1536, maxInputTokens: 8191 },
      { text: 'hello world' },
      { apiKey: 'sk-test' },
    )
    expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(1)
    const args = (mockEmbeddingsCreate.mock.calls as unknown as unknown[][])[0]?.[0] as Record<string, unknown>
    expect(args.model).toBe('text-embedding-3-small')
    expect(args.input).toBe('hello world')
  })

  it('returns the vector and the token count from usage', async () => {
    const result = await openaiEmbeddingProvider.embed(
      { id: 'text-embedding-3-small', name: 'small', dimensions: 1536, maxInputTokens: 8191 },
      { text: 'hi' },
      { apiKey: 'sk-test' },
    )
    expect(result.vector).toEqual([0.1, 0.2, 0.3])
    expect(result.inputTokens).toBe(42)
  })

  it('returns inputTokens undefined when the response has no usage', async () => {
    // Cast through `unknown` because the mock's return-type was inferred
    // from its initial impl (which included `usage`); without `usage` here
    // TS thinks the shape doesn't match. The provider code happily handles
    // the missing `usage` field at runtime.
    mockEmbeddingsCreate.mockImplementation((() => Promise.resolve({
      data: [{ embedding: [0.5] }],
    })) as unknown as typeof mockEmbeddingsCreate extends (...args: infer A) => infer R ? (...args: A) => R : never)
    const result = await openaiEmbeddingProvider.embed(
      { id: 'text-embedding-3-small', name: 'small', dimensions: 1536, maxInputTokens: 8191 },
      { text: 'hi' },
      { apiKey: 'sk-test' },
    )
    expect(result.inputTokens).toBeUndefined()
  })

  it('throws ProviderServerError when the API returns no vector', async () => {
    mockEmbeddingsCreate.mockImplementation(() => Promise.resolve({
      data: [],
      usage: { prompt_tokens: 0 },
    }))
    await expect(
      openaiEmbeddingProvider.embed(
        { id: 'text-embedding-3-small', name: 'small', dimensions: 1536, maxInputTokens: 8191 },
        { text: 'hi' },
        { apiKey: 'sk-test' },
      ),
    ).rejects.toBeInstanceOf(ProviderServerError)
  })
})
