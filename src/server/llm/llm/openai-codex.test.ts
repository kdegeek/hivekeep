import { describe, expect, it } from 'bun:test'
import { STATIC_CODEX_MODELS, mapCodexModel } from './openai-codex'

describe('STATIC_CODEX_MODELS (fallback catalog)', () => {
  it('ships the curated Codex fallback slugs in probe/default order', () => {
    const slugs = STATIC_CODEX_MODELS.map((m) => m.slug)
    expect(slugs).toEqual(['gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.3-codex-spark'])
    expect(slugs).not.toContain('gpt-5.4-mini')
    expect(slugs[0]).toBe('gpt-5.5')
    // All entries must be API-listable so resolveCodexModels surfaces them.
    expect(STATIC_CODEX_MODELS.every((m) => m.supported_in_api && m.visibility === 'list')).toBe(true)
  })

  it('maps the first fallback to the live-confirmed GPT-5.5 probe/default model', () => {
    const m = mapCodexModel(STATIC_CODEX_MODELS[0]!)
    expect(m.id).toBe('gpt-5.5')
    expect(m.name.length).toBeGreaterThan(0)
    expect(m.contextWindow).toBeGreaterThan(0)
    expect(m.thinking?.efforts).toEqual(['low', 'medium', 'high'])
    expect(m.supportsImageInput).toBe(true)
  })
})
