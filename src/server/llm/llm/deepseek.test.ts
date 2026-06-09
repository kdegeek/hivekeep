import { describe, expect, it } from 'bun:test'
import { inferContextWindow, mapModel, type DeepSeekModel } from './deepseek'

// Representative fixtures drawn from the live /models payload shape:
// the bare OpenAI listing `{object:'list', data:[{id, object, owned_by}]}`.

const v4Pro: DeepSeekModel = {
  id: 'deepseek-v4-pro',
  object: 'model',
  owned_by: 'deepseek',
}

const v4Flash: DeepSeekModel = {
  id: 'deepseek-v4-flash',
  object: 'model',
  owned_by: 'deepseek',
}

// ─── inferContextWindow ──────────────────────────────────────────────────────

describe('inferContextWindow', () => {
  it('maps the deepseek-v4 family to 128k', () => {
    expect(inferContextWindow(v4Pro)).toBe(128_000)
    expect(inferContextWindow(v4Flash)).toBe(128_000)
  })

  it('falls back to the 128k default when no family matches', () => {
    expect(inferContextWindow({ id: 'mystery-model' })).toBe(128_000)
  })
})

// ─── mapModel ────────────────────────────────────────────────────────────────

describe('mapModel', () => {
  it('classifies a model as a text-only llm with no vision and no thinking', () => {
    const m = mapModel(v4Pro)!
    expect(m.id).toBe('deepseek-v4-pro')
    expect(m.name).toBe('deepseek-v4-pro')
    expect(m.contextWindow).toBe(128_000)
    expect(m.supportsPromptCaching).toBe(true)
    expect(m.supportsParallelTools).toBe(true)
    // Vision is never advertised — no modality metadata in /models.
    expect(m.supportsImageInput).toBeUndefined()
    // Reasoning is never advertised — reasoning_effort support is unconfirmed.
    expect(m.thinking).toBeUndefined()
  })

  it('maps the flash tier the same way', () => {
    const m = mapModel(v4Flash)!
    expect(m.id).toBe('deepseek-v4-flash')
    expect(m.contextWindow).toBe(128_000)
    expect(m.thinking).toBeUndefined()
    expect(m.supportsImageInput).toBeUndefined()
  })

  it('returns null for entries without an id', () => {
    expect(mapModel({ id: '' })).toBeNull()
  })
})

// ─── listModels payload parsing ──────────────────────────────────────────────

describe('listModels payload shape', () => {
  // The provider's listModels reads `payload.data` from the OpenAI-style
  // `{object:'list', data:[{id}]}` response. Verify mapModel handles the full
  // listing (including a degenerate id-less entry) the way listModels does.
  it('maps every model in a {data:[{id}]} listing, dropping id-less entries', () => {
    const payload: { object: string; data: DeepSeekModel[] } = {
      object: 'list',
      data: [v4Flash, v4Pro, { id: '' }],
    }
    const mapped = payload.data.map(mapModel).filter((m): m is NonNullable<typeof m> => m !== null)
    expect(mapped.map((m) => m.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
  })
})
