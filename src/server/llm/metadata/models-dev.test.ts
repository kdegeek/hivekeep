import { afterAll, describe, expect, it } from 'bun:test'
import {
  __setSnapshotForTests,
  matchModelsDev,
  modelsDevToMetadata,
  resolveFromModelsDev,
  toModelsDevProviderId,
  type ModelsDevModel,
} from './models-dev'
import { mergeMetadata } from './resolve'

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
