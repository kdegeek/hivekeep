import { describe, expect, it } from 'bun:test'
import { assistantMessage, mapModel, type DeepSeekModel } from './deepseek'

// Representative fixtures drawn from the live /models payload shape:
// the bare OpenAI listing `{object:'list', data:[{id, object, owned_by}]}`.

const v4Pro: DeepSeekModel = {
  id: 'deepseek-v4-pro',
  object: 'model',
  owned_by: 'deepseek',
}

// ─── mapModel (metadata now comes from the registry, not heuristics) ─────────

describe('mapModel', () => {
  it('returns the bare model — no name-based context/thinking/vision guesses', () => {
    const m = mapModel(v4Pro)!
    expect(m.id).toBe('deepseek-v4-pro')
    expect(m.name).toBe('deepseek-v4-pro')
    expect(m.supportsPromptCaching).toBe(true)
    expect(m.supportsParallelTools).toBe(true)
    // Metadata is filled by the model registry (models.dev), not here.
    expect(m.contextWindow).toBeUndefined()
    expect(m.thinking).toBeUndefined()
    expect(m.supportsImageInput).toBeUndefined()
  })

  it('returns null for entries without an id', () => {
    expect(mapModel({ id: '' })).toBeNull()
  })
})

// ─── assistantMessage (reasoning_content replay) ─────────────────────────────

describe('assistantMessage', () => {
  // DeepSeek (thinking on by default) 400s on a tool-call message that lacks
  // reasoning_content. The engine strips unsigned thinking, so it is usually
  // empty here — the empty string is what prevents the 400.
  it('sets reasoning_content (empty) on a tool-call message with no thinking', () => {
    const msg = assistantMessage([
      { type: 'tool-use', id: 'c1', name: 'get_weather', args: { city: 'Paris' } },
    ]) as { tool_calls?: unknown[]; reasoning_content?: string }
    expect(msg.tool_calls).toHaveLength(1)
    expect(msg.reasoning_content).toBe('')
  })

  it('replays real reasoning text when a thinking block is present', () => {
    const msg = assistantMessage([
      { type: 'thinking', text: 'I should call the weather tool.' },
      { type: 'tool-use', id: 'c1', name: 'get_weather', args: { city: 'Paris' } },
    ]) as { reasoning_content?: string }
    expect(msg.reasoning_content).toBe('I should call the weather tool.')
  })

  it('does NOT attach reasoning_content to a plain text message', () => {
    const msg = assistantMessage([{ type: 'text', text: 'Hi.' }]) as {
      content?: string
      reasoning_content?: string
    }
    expect(msg.content).toBe('Hi.')
    expect('reasoning_content' in msg).toBe(false)
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
      data: [{ id: 'deepseek-v4-flash' }, v4Pro, { id: '' }],
    }
    const mapped = payload.data.map(mapModel).filter((m): m is NonNullable<typeof m> => m !== null)
    expect(mapped.map((m) => m.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
  })
})
