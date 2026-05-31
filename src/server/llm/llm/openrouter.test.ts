import { describe, expect, it } from 'bun:test'
import {
  inferImageInput,
  inferThinking,
  inferMaxTools,
  convertPricing,
  isTextOutputModel,
  mapModel,
  type OpenRouterModel,
} from './openrouter'

// Representative fixtures drawn from the live /api/v1/models payload shape.

/** Anthropic Claude via OpenRouter: vision + tools + reasoning. */
const claudeOpus: OpenRouterModel = {
  id: 'anthropic/claude-opus-4.8',
  name: 'Anthropic: Claude Opus 4.8',
  context_length: 1_000_000,
  architecture: {
    input_modalities: ['text', 'image', 'file'],
    output_modalities: ['text'],
  },
  pricing: {
    prompt: '0.000005',
    completion: '0.000025',
    input_cache_read: '0.0000005',
    input_cache_write: '0.00000625',
  },
  supported_parameters: ['include_reasoning', 'max_tokens', 'reasoning', 'tools', 'tool_choice'],
}

/** Text-only, tool-capable, no reasoning. */
const ibmGranite: OpenRouterModel = {
  id: 'ibm-granite/granite-4.1-8b',
  name: 'IBM: Granite 4.1 8B',
  context_length: 131_072,
  architecture: {
    input_modalities: ['text'],
    output_modalities: ['text'],
  },
  pricing: { prompt: '0.00000005', completion: '0.0000001' },
  supported_parameters: ['max_tokens', 'tools', 'tool_choice', 'temperature'],
}

/** Completion-only: no `tools` in supported_parameters. */
const completionOnly: OpenRouterModel = {
  id: 'openrouter/pareto-code',
  name: 'Pareto Code Router',
  context_length: 2_000_000,
  architecture: {
    input_modalities: ['text'],
    output_modalities: ['text'],
  },
  pricing: { prompt: '-1', completion: '-1' },
  supported_parameters: [],
}

/** Image-generation model: output is image, not chat-usable. */
const imageGen: OpenRouterModel = {
  id: 'google/gemini-3.1-flash-image-preview',
  name: 'Google: Nano Banana 2',
  context_length: 131_072,
  architecture: {
    input_modalities: ['image', 'text'],
    output_modalities: ['image', 'text'],
  },
  pricing: { prompt: '0.0000005', completion: '0.000003' },
  supported_parameters: ['max_tokens', 'reasoning'],
}

/** Audio-only output: not chat-usable. */
const audioGen: OpenRouterModel = {
  id: 'some/audio-only-model',
  name: 'Audio Only Model',
  context_length: 1_048_576,
  architecture: {
    input_modalities: ['text'],
    output_modalities: ['audio'],
  },
  pricing: { prompt: '0', completion: '0' },
  supported_parameters: ['max_tokens'],
}

// ─── inferImageInput ─────────────────────────────────────────────────────────

describe('inferImageInput', () => {
  it('is true when input_modalities includes image', () => {
    expect(inferImageInput(claudeOpus)).toBe(true)
    expect(inferImageInput(imageGen)).toBe(true)
  })

  it('is false for text-only input', () => {
    expect(inferImageInput(ibmGranite)).toBe(false)
    expect(inferImageInput(completionOnly)).toBe(false)
  })

  it('is false when architecture/modalities are absent', () => {
    expect(inferImageInput({ id: 'x' })).toBe(false)
    expect(inferImageInput({ id: 'x', architecture: {} })).toBe(false)
  })
})

// ─── inferThinking ───────────────────────────────────────────────────────────

describe('inferThinking', () => {
  it('detects reasoning support from supported_parameters', () => {
    expect(inferThinking(claudeOpus)!.efforts).toEqual(['low', 'medium', 'high'])
  })

  it('returns undefined when reasoning is not supported', () => {
    expect(inferThinking(ibmGranite)).toBeUndefined()
    expect(inferThinking(completionOnly)).toBeUndefined()
  })

  it('never reports a max effort (OpenRouter caps at high)', () => {
    expect(inferThinking(claudeOpus)!.efforts).not.toContain('max')
  })
})

// ─── inferMaxTools ───────────────────────────────────────────────────────────

describe('inferMaxTools', () => {
  it('returns undefined (inherit default) for tool-capable models', () => {
    expect(inferMaxTools(claudeOpus)).toBeUndefined()
    expect(inferMaxTools(ibmGranite)).toBeUndefined()
  })

  it('returns 0 for completion-only models', () => {
    expect(inferMaxTools(completionOnly)).toBe(0)
    expect(inferMaxTools({ id: 'x', supported_parameters: ['max_tokens'] })).toBe(0)
    expect(inferMaxTools({ id: 'x' })).toBe(0)
  })
})

// ─── convertPricing ──────────────────────────────────────────────────────────

describe('convertPricing', () => {
  it('converts USD/token to USD/million', () => {
    const p = convertPricing(claudeOpus)!
    expect(p.input).toBeCloseTo(5, 6)
    expect(p.output).toBeCloseTo(25, 6)
    expect(p.cacheRead).toBeCloseTo(0.5, 6)
    expect(p.cacheWrite).toBeCloseTo(6.25, 6)
  })

  it('drops negative sentinel prices (variable routers)', () => {
    expect(convertPricing(completionOnly)).toBeUndefined()
  })

  it('handles zero pricing (free models)', () => {
    const p = convertPricing({ id: 'x', pricing: { prompt: '0', completion: '0' } })!
    expect(p.input).toBe(0)
    expect(p.output).toBe(0)
  })

  it('returns undefined when pricing is absent', () => {
    expect(convertPricing({ id: 'x' })).toBeUndefined()
  })

  it('omits cache fields when not provided', () => {
    const p = convertPricing(ibmGranite)!
    expect(p.cacheRead).toBeUndefined()
    expect(p.cacheWrite).toBeUndefined()
  })
})

// ─── isTextOutputModel ───────────────────────────────────────────────────────

describe('isTextOutputModel', () => {
  it('accepts text-output models', () => {
    expect(isTextOutputModel(claudeOpus)).toBe(true)
    expect(isTextOutputModel(ibmGranite)).toBe(true)
    expect(isTextOutputModel(imageGen)).toBe(true) // outputs image + text
  })

  it('rejects audio-only output', () => {
    expect(isTextOutputModel(audioGen)).toBe(false)
  })

  it('assumes text when output_modalities is absent', () => {
    expect(isTextOutputModel({ id: 'x' })).toBe(true)
    expect(isTextOutputModel({ id: 'x', architecture: {} })).toBe(true)
  })
})

// ─── mapModel ────────────────────────────────────────────────────────────────

describe('mapModel', () => {
  it('maps a full vision/reasoning/tool model', () => {
    const m = mapModel(claudeOpus)!
    expect(m.id).toBe('anthropic/claude-opus-4.8')
    expect(m.name).toBe('Anthropic: Claude Opus 4.8')
    expect(m.contextWindow).toBe(1_000_000)
    expect(m.supportsImageInput).toBe(true)
    expect(m.thinking?.efforts).toEqual(['low', 'medium', 'high'])
    expect(m.maxTools).toBeUndefined()
    expect(m.pricing?.input).toBeCloseTo(5, 6)
  })

  it('marks completion-only models with maxTools 0', () => {
    const m = mapModel(completionOnly)!
    expect(m.maxTools).toBe(0)
    expect(m.supportsImageInput).toBeUndefined()
    expect(m.thinking).toBeUndefined()
  })

  it('omits image flag and thinking for plain text models', () => {
    const m = mapModel(ibmGranite)!
    expect(m.supportsImageInput).toBeUndefined()
    expect(m.thinking).toBeUndefined()
    expect(m.maxTools).toBeUndefined()
    expect(m.contextWindow).toBe(131_072)
  })

  it('drops audio-only output models', () => {
    expect(mapModel(audioGen)).toBeNull()
  })

  it('returns null for entries without an id', () => {
    expect(mapModel({ id: '' })).toBeNull()
  })

  it('falls back to top_provider.context_length when context_length is null', () => {
    const m = mapModel({
      id: 'x',
      context_length: null,
      architecture: { output_modalities: ['text'] },
      top_provider: { context_length: 196_608 },
    })!
    expect(m.contextWindow).toBe(196_608)
  })
})
