import { afterAll, describe, expect, it } from 'bun:test'
import {
  __setSnapshotForTests,
  matchModelsDev,
  modelsDevToMetadata,
  resolveFromModelsDev,
  toModelsDevProviderId,
  type ModelsDevModel,
} from './models-dev'
import { mergeMetadata, mergeAutoMetadata } from './resolve'

// Fixture mirrors the real snapshot shape (a few providers + models).
const SNAP = {
  deepseek: {
    'deepseek-v4-flash': {
      name: 'DeepSeek V4 Flash',
      family: 'deepseek-flash',
      context: 1_000_000,
      output: 384_000,
      input: ['text'],
      reasoning: true,
      reasoning_efforts: ['high', 'max'],
      tool_call: true,
      cost: { input: 0.14, output: 0.28, cache_read: 0.0028 },
    } satisfies ModelsDevModel,
  },
  minimax: {
    'MiniMax-M3': {
      name: 'MiniMax-M3',
      context: 512_000,
      input: ['text', 'image', 'video'],
      reasoning: true,
      tool_call: true,
    } satisfies ModelsDevModel,
  },
  moonshotai: {
    'kimi-k2.6': { name: 'Kimi K2.6', context: 262_144, input: ['text'], reasoning: true } satisfies ModelsDevModel,
  },
  google: {
    'gemini-3-pro': { name: 'Gemini 3 Pro', context: 1_048_576, input: ['text', 'image', 'pdf'] } satisfies ModelsDevModel,
  },
}

__setSnapshotForTests(SNAP as never)
afterAll(() => __setSnapshotForTests(null))

describe('toModelsDevProviderId', () => {
  it('maps the diverging provider ids', () => {
    expect(toModelsDevProviderId('moonshot')).toBe('moonshotai')
    expect(toModelsDevProviderId('gemini')).toBe('google')
  })
  it('passes others through unchanged', () => {
    expect(toModelsDevProviderId('deepseek')).toBe('deepseek')
    expect(toModelsDevProviderId('openai')).toBe('openai')
  })
})

describe('matchModelsDev', () => {
  it('matches an exact id', () => {
    const m = matchModelsDev('deepseek', 'deepseek-v4-flash')!
    expect(m.confidence).toBe('exact')
    expect(m.key).toBe('deepseek/deepseek-v4-flash')
  })

  it('matches case-insensitively (normalized)', () => {
    const m = matchModelsDev('minimax', 'minimax-m3')!
    expect(m.confidence).toBe('normalized')
    expect(m.key).toBe('minimax/MiniMax-M3')
  })

  it('applies the provider-id map (moonshot→moonshotai, gemini→google)', () => {
    expect(matchModelsDev('moonshot', 'kimi-k2.6')!.key).toBe('moonshotai/kimi-k2.6')
    expect(matchModelsDev('gemini', 'gemini-3-pro')!.confidence).toBe('exact')
  })

  it('strips a dashed ISO date suffix (OpenAI-style) to the base model', () => {
    // gemini-3-pro-2025-08-07 → gemini-3-pro (the 2-digit month/day evade the
    // pure-digit rule, so this needs the dedicated date strip).
    const m = matchModelsDev('gemini', 'gemini-3-pro-2025-08-07')!
    expect(m.confidence).toBe('normalized')
    expect(m.key).toBe('google/gemini-3-pro')
  })

  it('returns null for plugin providers (never in models.dev)', () => {
    expect(matchModelsDev('plugin:acme:custom', 'deepseek-v4-flash')).toBeNull()
  })

  it('returns null when the provider or model is unknown', () => {
    expect(matchModelsDev('deepseek', 'totally-made-up')).toBeNull()
    expect(matchModelsDev('no-such-provider', 'x')).toBeNull()
    expect(matchModelsDev('deepseek', '')).toBeNull()
  })
})

describe('modelsDevToMetadata', () => {
  it('maps DeepSeek V4 (1M, text-only, reasoning w/ efforts, pricing)', () => {
    const md = modelsDevToMetadata(SNAP.deepseek['deepseek-v4-flash'])
    expect(md.displayName).toBe('DeepSeek V4 Flash')
    expect(md.contextWindow).toBe(1_000_000)
    expect(md.maxOutput).toBe(384_000)
    expect(md.supportsImageInput).toBe(false)
    expect(md.supportsPdfInput).toBe(false)
    expect(md.supportsToolCall).toBe(true)
    expect(md.thinking?.efforts).toEqual(['high', 'max'])
    expect(md.pricing).toEqual({ input: 0.14, output: 0.28, cacheRead: 0.0028 })
  })

  it('maps MiniMax-M3 as image-capable, reasoning toggle-only (efforts: [])', () => {
    const md = modelsDevToMetadata(SNAP.minimax['MiniMax-M3'])
    expect(md.contextWindow).toBe(512_000)
    expect(md.supportsImageInput).toBe(true)
    expect(md.supportsPdfInput).toBe(false)
    expect(md.thinking).toEqual({ efforts: [] })
  })

  it('maps a pdf-capable model', () => {
    const md = modelsDevToMetadata(SNAP.google['gemini-3-pro'])
    expect(md.supportsImageInput).toBe(true)
    expect(md.supportsPdfInput).toBe(true)
    expect(md.thinking).toBeUndefined() // no reasoning flag
  })

  it('resolveFromModelsDev combines match + mapping', () => {
    const r = resolveFromModelsDev('deepseek', 'deepseek-v4-flash')!
    expect(r.match.confidence).toBe('exact')
    expect(r.metadata.contextWindow).toBe(1_000_000)
    expect(r.metadata.displayName).toBe('DeepSeek V4 Flash')
  })

  it('omits displayName when models.dev has no name', () => {
    const md = modelsDevToMetadata({ context: 1000 })
    expect(md.displayName).toBeUndefined()
  })

  it('keeps the full minimal→xhigh→max ladder and drops non-enum values (none)', () => {
    const md = modelsDevToMetadata({
      reasoning: true,
      reasoning_efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'default'],
    })
    expect(md.thinking?.efforts).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('mergeMetadata (priority: override > models.dev > apiSeed > default)', () => {
  it('takes the first defined value per field', () => {
    const override = { contextWindow: 200_000 }
    const modelsDev = { contextWindow: 1_000_000, supportsImageInput: false, maxOutput: 384_000 }
    const apiSeed = { supportsImageInput: true, contextWindow: 999 }
    const defaults = { contextWindow: 128_000, supportsToolCall: true }
    const merged = mergeMetadata(override, modelsDev, apiSeed, defaults)
    expect(merged.contextWindow).toBe(200_000) // override wins
    expect(merged.supportsImageInput).toBe(false) // models.dev wins over apiSeed
    expect(merged.maxOutput).toBe(384_000) // only models.dev had it
    expect(merged.supportsToolCall).toBe(true) // only default had it
  })

  it('ignores null/undefined layers', () => {
    const merged = mergeMetadata(null, undefined, { contextWindow: 42 })
    expect(merged.contextWindow).toBe(42)
  })
})

describe('mergeAutoMetadata (apiSeed > models.dev, except explicit efforts)', () => {
  it('lets a non-empty models.dev effort list beat the seed heuristic', () => {
    const apiSeed = { thinking: { efforts: ['low', 'medium', 'high'] as const } }
    const modelsDev = { thinking: { efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'] as const } }
    const merged = mergeAutoMetadata(apiSeed as never, modelsDev as never)
    expect(merged.thinking?.efforts).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])
  })

  it('never lets an empty models.dev effort list clobber a seed with efforts', () => {
    // e.g. Anthropic: capabilities API advertises efforts; models.dev entry is
    // budget_tokens-only → efforts: [].
    const apiSeed = { thinking: { efforts: ['low', 'medium', 'high', 'max'] as const } }
    const modelsDev = { thinking: { efforts: [] as const } }
    const merged = mergeAutoMetadata(apiSeed as never, modelsDev as never)
    expect(merged.thinking?.efforts).toEqual(['low', 'medium', 'high', 'max'])
  })

  it('falls back to models.dev toggle-only when the seed has no opinion', () => {
    const merged = mergeAutoMetadata({}, { thinking: { efforts: [] } })
    expect(merged.thinking).toEqual({ efforts: [] })
  })

  it('keeps the generic priority for every other field', () => {
    const merged = mergeAutoMetadata({ contextWindow: 999 }, { contextWindow: 1_000_000, maxOutput: 64_000 })
    expect(merged.contextWindow).toBe(999) // apiSeed wins
    expect(merged.maxOutput).toBe(64_000) // models.dev fills the gap
  })
})
