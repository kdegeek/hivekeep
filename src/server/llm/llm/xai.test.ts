import { describe, expect, it } from 'bun:test'
import {
  inferImageInput,
  isTextOutputModel,
  convertPricing,
  mapModel,
  type XaiLanguageModel,
} from './xai'

// Representative fixtures drawn from the live /v1/language-models payload shape.

/** grok-4.3 via the obfuscated canonical id "latest"; family in aliases. */
const grok43: XaiLanguageModel = {
  id: 'latest',
  aliases: ['grok-4.3-latest', 'grok-latest'],
  input_modalities: ['text', 'image'],
  output_modalities: ['text'],
  prompt_text_token_price: 12500,
  cached_prompt_text_token_price: 2000,
  completion_text_token_price: 25000,
}

/** A *-reasoning variant, text-only. */
const grokReasoning: XaiLanguageModel = {
  id: 'grok-420-reasoning',
  aliases: [],
  input_modalities: ['text'],
  output_modalities: ['text'],
  prompt_text_token_price: 20000,
  cached_prompt_text_token_price: 2000,
  completion_text_token_price: 80000,
}

/** Plain grok-4: reasons internally but rejects reasoning_effort -> NOT thinking. */
const grok4: XaiLanguageModel = {
  id: 'grok-4-0709',
  aliases: ['grok-4', 'grok-4-latest'],
  input_modalities: ['text', 'image'],
  output_modalities: ['text'],
  prompt_text_token_price: 30000,
  completion_text_token_price: 150000,
}

/** grok-3-mini: small reasoning model. */
const grok3Mini: XaiLanguageModel = {
  id: 'grok-3-mini',
  aliases: ['grok-3-mini-latest'],
  input_modalities: ['text'],
  output_modalities: ['text'],
  prompt_text_token_price: 3000,
  completion_text_token_price: 5000,
}

/** Hypothetical audio-only output: not chat-usable. */
const audioOnly: XaiLanguageModel = {
  id: 'grok-audio',
  input_modalities: ['text'],
  output_modalities: ['audio'],
}

// ─── inferImageInput (genuine xAI API: input_modalities) ─────────────────────

describe('inferImageInput', () => {
  it('is true when input_modalities includes image', () => {
    expect(inferImageInput(grok43)).toBe(true)
    expect(inferImageInput(grok4)).toBe(true)
  })

  it('is false for text-only input', () => {
    expect(inferImageInput(grokReasoning)).toBe(false)
    expect(inferImageInput(grok3Mini)).toBe(false)
  })

  it('is false when input_modalities is absent', () => {
    expect(inferImageInput({ id: 'x' })).toBe(false)
  })
})

// ─── isTextOutputModel ───────────────────────────────────────────────────────

describe('isTextOutputModel', () => {
  it('accepts text-output models', () => {
    expect(isTextOutputModel(grok43)).toBe(true)
    expect(isTextOutputModel(grokReasoning)).toBe(true)
  })

  it('rejects audio-only output', () => {
    expect(isTextOutputModel(audioOnly)).toBe(false)
  })

  it('assumes text when output_modalities is absent', () => {
    expect(isTextOutputModel({ id: 'x' })).toBe(true)
  })
})

// ─── convertPricing ──────────────────────────────────────────────────────────

describe('convertPricing', () => {
  it('converts USD cents per 100M tokens to USD per million', () => {
    const p = convertPricing(grok43)!
    expect(p.input).toBeCloseTo(1.25, 6)
    expect(p.output).toBeCloseTo(2.5, 6)
    expect(p.cacheRead).toBeCloseTo(0.2, 6)
  })

  it('omits cacheRead when not provided', () => {
    const p = convertPricing(grok4)!
    expect(p.input).toBeCloseTo(3, 6)
    expect(p.output).toBeCloseTo(15, 6)
    expect(p.cacheRead).toBeUndefined()
  })

  it('returns undefined when pricing is absent', () => {
    expect(convertPricing({ id: 'x' })).toBeUndefined()
  })

  it('drops negative sentinel prices', () => {
    expect(
      convertPricing({ id: 'x', prompt_text_token_price: -1, completion_text_token_price: -1 }),
    ).toBeUndefined()
  })
})

// ─── mapModel ────────────────────────────────────────────────────────────────

describe('mapModel', () => {
  it('keeps the genuine API fields (image, pricing); context/thinking → registry', () => {
    const m = mapModel(grok43)!
    expect(m.id).toBe('latest')
    expect(m.supportsImageInput).toBe(true)
    expect(m.pricing?.input).toBeCloseTo(1.25, 6)
    // Context window + reasoning are no longer guessed here.
    expect(m.contextWindow).toBeUndefined()
    expect(m.thinking).toBeUndefined()
  })

  it('keeps image flag from the API for vision models', () => {
    const m = mapModel(grok4)!
    expect(m.supportsImageInput).toBe(true)
    expect(m.contextWindow).toBeUndefined()
  })

  it('leaves image unset for text-only models', () => {
    const m = mapModel(grokReasoning)!
    expect(m.supportsImageInput).toBeUndefined()
    expect(m.thinking).toBeUndefined()
  })

  it('drops audio-only output models', () => {
    expect(mapModel(audioOnly)).toBeNull()
  })

  it('returns null for entries without an id', () => {
    expect(mapModel({ id: '' })).toBeNull()
  })
})
