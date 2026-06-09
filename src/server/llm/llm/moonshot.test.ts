import { describe, expect, it } from 'bun:test'
import {
  assistantMessage,
  inferContextWindow,
  inferImageInput,
  inferThinking,
  mapModel,
  type MoonshotModel,
} from './moonshot'

// Fixtures mirror the LIVE /models payload, which enriches each entry with
// authoritative capability metadata: `context_length`, `supports_image_in`,
// `supports_video_in`, `supports_reasoning`. The provider reads those fields
// and only falls back to id heuristics when one is absent.

const k26: MoonshotModel = {
  id: 'kimi-k2.6',
  object: 'model',
  owned_by: 'moonshot',
  context_length: 262_144,
  supports_image_in: true,
  supports_video_in: true,
  supports_reasoning: true,
}
const k25: MoonshotModel = {
  id: 'kimi-k2.5',
  object: 'model',
  owned_by: 'moonshot',
  context_length: 262_144,
  supports_image_in: true,
  supports_video_in: true,
  supports_reasoning: true,
}
const v1_8k: MoonshotModel = {
  id: 'moonshot-v1-8k',
  object: 'model',
  owned_by: 'moonshot',
  context_length: 8_192,
}
const v1_32k: MoonshotModel = {
  id: 'moonshot-v1-32k',
  object: 'model',
  owned_by: 'moonshot',
  context_length: 32_768,
}
const v1_128k: MoonshotModel = {
  id: 'moonshot-v1-128k',
  object: 'model',
  owned_by: 'moonshot',
  context_length: 131_072,
}
const v1_auto: MoonshotModel = {
  id: 'moonshot-v1-auto',
  object: 'model',
  owned_by: 'moonshot',
  context_length: 131_072,
}
const v1_8kVision: MoonshotModel = {
  id: 'moonshot-v1-8k-vision-preview',
  object: 'model',
  owned_by: 'moonshot',
  context_length: 8_192,
  supports_image_in: true,
}
const v1_128kVision: MoonshotModel = {
  id: 'moonshot-v1-128k-vision-preview',
  object: 'model',
  owned_by: 'moonshot',
  context_length: 131_072,
  supports_image_in: true,
}

// "Bare" entries (metadata fields omitted) exercise the id-heuristic fallback
// that keeps the provider correct if Moonshot ever drops the enriched fields.
const bareK2: MoonshotModel = { id: 'kimi-k2.6' }
const bareV1_32k: MoonshotModel = { id: 'moonshot-v1-32k' }
const bareV1Vision: MoonshotModel = { id: 'moonshot-v1-8k-vision-preview' }

// ─── inferContextWindow ──────────────────────────────────────────────────────

describe('inferContextWindow', () => {
  it('prefers the API-provided context_length', () => {
    expect(inferContextWindow(k26)).toBe(262_144)
    expect(inferContextWindow(v1_8k)).toBe(8_192)
    expect(inferContextWindow(v1_32k)).toBe(32_768)
    expect(inferContextWindow(v1_128k)).toBe(131_072)
    expect(inferContextWindow(v1_auto)).toBe(131_072)
  })

  it('trusts context_length even when it disagrees with the id heuristic', () => {
    expect(inferContextWindow({ id: 'moonshot-v1-8k', context_length: 999 })).toBe(999)
  })

  it('falls back to the id suffix when context_length is absent', () => {
    expect(inferContextWindow(bareK2)).toBe(262_144)
    expect(inferContextWindow(bareV1_32k)).toBe(32_768)
    expect(inferContextWindow(bareV1Vision)).toBe(8_192)
  })

  it('falls back to the 128k default when no field or suffix matches', () => {
    expect(inferContextWindow({ id: 'mystery-model' })).toBe(131_072)
  })

  it('ignores a non-positive context_length and falls back to the heuristic', () => {
    expect(inferContextWindow({ id: 'moonshot-v1-32k', context_length: 0 })).toBe(32_768)
  })
})

// ─── inferImageInput (vision classification) ─────────────────────────────────

describe('inferImageInput', () => {
  it('prefers the API supports_image_in flag', () => {
    // The flagship has NO "vision" in its id but IS image-capable — the API
    // flag is the only thing that catches it. This is the bug the heuristic
    // alone would miss.
    expect(inferImageInput(k26)).toBe(true)
    expect(inferImageInput(k25)).toBe(true)
    expect(inferImageInput(v1_8kVision)).toBe(true)
    expect(inferImageInput(v1_128kVision)).toBe(true)
  })

  it('respects an explicit supports_image_in:false over a misleading id', () => {
    expect(
      inferImageInput({ id: 'moonshot-v1-8k-vision-preview', supports_image_in: false }),
    ).toBe(false)
  })

  it('returns false for text-only models (no flag, no "vision" in id)', () => {
    expect(inferImageInput(v1_8k)).toBe(false)
    expect(inferImageInput(v1_auto)).toBe(false)
  })

  it('falls back to the "vision" id heuristic when the flag is absent', () => {
    expect(inferImageInput(bareV1Vision)).toBe(true)
    expect(inferImageInput(bareK2)).toBe(false)
  })
})

// ─── inferThinking (reasoning classification) ────────────────────────────────

describe('inferThinking', () => {
  it('advertises the low/medium/high effort range for reasoning-flagged models', () => {
    const t = inferThinking(k26)
    expect(t).toBeDefined()
    expect(t!.efforts).toEqual(['low', 'medium', 'high'])
    expect(typeof t!.note).toBe('string')
    expect(inferThinking(k25)).toBeDefined()
  })

  it('returns undefined for models the API does not mark reasoning-capable', () => {
    expect(inferThinking(v1_8k)).toBeUndefined()
    expect(inferThinking(v1_8kVision)).toBeUndefined()
    expect(inferThinking(v1_auto)).toBeUndefined()
  })

  it('does not infer reasoning from the id alone (only the explicit flag)', () => {
    // A bare flagship entry (no supports_reasoning field) gets NO thinking,
    // even though its id is a kimi-k2 flagship.
    expect(inferThinking(bareK2)).toBeUndefined()
  })
})

// ─── mapModel ────────────────────────────────────────────────────────────────

describe('mapModel', () => {
  it('classifies the flagship as an image- and reasoning-capable llm', () => {
    const m = mapModel(k26)!
    expect(m.id).toBe('kimi-k2.6')
    expect(m.name).toBe('kimi-k2.6')
    expect(m.contextWindow).toBe(262_144)
    expect(m.supportsPromptCaching).toBe(true)
    expect(m.supportsParallelTools).toBe(true)
    // The API reports supports_image_in:true even though the id has no "vision".
    expect(m.supportsImageInput).toBe(true)
    // The API reports supports_reasoning:true and accepts reasoning_effort.
    expect(m.thinking?.efforts).toEqual(['low', 'medium', 'high'])
  })

  it('sets supportsImageInput but no thinking on a vision-preview model', () => {
    const m = mapModel(v1_8kVision)!
    expect(m.id).toBe('moonshot-v1-8k-vision-preview')
    expect(m.contextWindow).toBe(8_192)
    expect(m.supportsImageInput).toBe(true)
    // Vision models are not reasoning models.
    expect(m.thinking).toBeUndefined()
  })

  it('leaves supportsImageInput and thinking undefined on a text-only model', () => {
    const m = mapModel(v1_128k)!
    expect(m.id).toBe('moonshot-v1-128k')
    expect(m.contextWindow).toBe(131_072)
    expect(m.supportsImageInput).toBeUndefined()
    expect(m.thinking).toBeUndefined()
  })

  it('returns null for entries without an id', () => {
    expect(mapModel({ id: '' })).toBeNull()
  })
})

// ─── assistantMessage (reasoning_content replay) ─────────────────────────────

describe('assistantMessage', () => {
  // Moonshot reasoning models 400 on a tool-call assistant message that lacks
  // reasoning_content. The engine strips unsigned thinking before replay, so it
  // is usually empty here — an empty string is what prevents the 400.
  it('sets reasoning_content (empty) on a tool-call message with no thinking', () => {
    const msg = assistantMessage([
      { type: 'tool-use', id: 'call_1', name: 'get_weather', args: { city: 'Paris' } },
    ]) as { tool_calls?: unknown[]; reasoning_content?: string }
    expect(msg.tool_calls).toHaveLength(1)
    expect(msg.reasoning_content).toBe('')
  })

  it('replays real reasoning text when a thinking block is present', () => {
    const msg = assistantMessage([
      { type: 'thinking', text: 'The user wants the weather, so I will call the tool.' },
      { type: 'tool-use', id: 'call_1', name: 'get_weather', args: { city: 'Paris' } },
    ]) as { tool_calls?: unknown[]; reasoning_content?: string }
    expect(msg.tool_calls).toHaveLength(1)
    expect(msg.reasoning_content).toBe('The user wants the weather, so I will call the tool.')
  })

  it('does NOT attach reasoning_content to a plain text message (no tool calls)', () => {
    const msg = assistantMessage([{ type: 'text', text: 'It is 18°C in Paris.' }]) as {
      content?: string
      reasoning_content?: string
      tool_calls?: unknown[]
    }
    expect(msg.content).toBe('It is 18°C in Paris.')
    expect(msg.tool_calls).toBeUndefined()
    expect('reasoning_content' in msg).toBe(false)
  })

  it('keeps assistant text alongside tool calls', () => {
    const msg = assistantMessage([
      { type: 'text', text: 'Let me check.' },
      { type: 'tool-use', id: 'call_1', name: 'get_weather', args: { city: 'Paris' } },
    ]) as { content?: string; tool_calls?: unknown[]; reasoning_content?: string }
    expect(msg.content).toBe('Let me check.')
    expect(msg.tool_calls).toHaveLength(1)
    expect(msg.reasoning_content).toBe('')
  })
})

// ─── listModels payload parsing ──────────────────────────────────────────────

describe('listModels payload shape', () => {
  // The provider's listModels reads `payload.data` from the OpenAI-style
  // `{object:'list', data:[{id, ...}]}` response. Verify mapModel handles the
  // full listing (including a degenerate id-less entry) the way listModels does.
  it('maps every model in a {data:[{id}]} listing, dropping id-less entries', () => {
    const payload: { object: string; data: MoonshotModel[] } = {
      object: 'list',
      data: [k26, v1_8k, v1_128kVision, { id: '' }],
    }
    const mapped = payload.data
      .map(mapModel)
      .filter((m): m is NonNullable<typeof m> => m !== null)
    expect(mapped.map((m) => m.id)).toEqual([
      'kimi-k2.6',
      'moonshot-v1-8k',
      'moonshot-v1-128k-vision-preview',
    ])
    // Vision classification survives the full-listing path, for both the
    // flag-via-id (vision-preview) and flag-via-API (flagship) cases.
    expect(mapped.find((m) => m.id === 'moonshot-v1-128k-vision-preview')!.supportsImageInput).toBe(
      true,
    )
    expect(mapped.find((m) => m.id === 'kimi-k2.6')!.supportsImageInput).toBe(true)
    expect(mapped.find((m) => m.id === 'moonshot-v1-8k')!.supportsImageInput).toBeUndefined()
  })
})
