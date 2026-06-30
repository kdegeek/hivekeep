import { describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { STATIC_CODEX_MODELS, mapCodexModel, openaiCodexProvider } from './openai-codex'
import { codexAccountIdFromTokens } from './_codex-auth'
import type { PkceTokenResponse } from './_oauth-pkce'
import type { ChatRequest } from './types'
import type { ProviderConfig } from '@/server/llm/core/types'

function makeJwt(claims: Record<string, unknown>): string {
  const seg = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `header.${seg}.sig`
}

function createCodexAuthConfig(): { config: ProviderConfig; cleanup: () => void } {
  const dir = join(tmpdir(), `hivekeep-codex-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const authFilePath = join(dir, 'auth.json')
  writeFileSync(
    authFilePath,
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: 'refresh-token',
        id_token: makeJwt({}),
        account_id: 'acc_test',
      },
      last_refresh: new Date().toISOString(),
    }),
  )
  return { config: { authFilePath }, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function codexSseResponse(text = 'ok'): Response {
  return new Response(
    `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n` +
      `data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 1 } } })}\n\n` +
      'data: [DONE]\n\n',
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

const basicRequest = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Say ok' }] }],
  ...overrides,
})

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

  it('uses a nonstandard absolute HOME cache before falling back', async () => {
    const home = '/tmp/hivekeep-codex-var-home'
    const oldHome = process.env.HOME
    const oldRealHome = process.env.REAL_HOME
    try {
      rmSync(home, { recursive: true, force: true })
      mkdirSync(`${home}/.codex`, { recursive: true })
      writeFileSync(
        `${home}/.codex/models_cache.json`,
        JSON.stringify({
          models: [
            {
              slug: 'gpt-test-cache',
              display_name: 'GPT Test Cache',
              supported_in_api: true,
              visibility: 'list',
              priority: 1,
            },
          ],
        }),
      )
      process.env.HOME = home
      delete process.env.REAL_HOME

      const mod = await import(`./openai-codex?nonstandard-home=${Date.now()}`)
      const models = mod.resolveLocalCodexModels()
      expect(models[0].slug).toBe('gpt-test-cache')
    } finally {
      if (oldHome === undefined) delete process.env.HOME
      else process.env.HOME = oldHome
      if (oldRealHome === undefined) delete process.env.REAL_HOME
      else process.env.REAL_HOME = oldRealHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('mapCodexModel', () => {
  it('derives reasoning levels, image support and context window from backend metadata', () => {
    // Shape returned by GET /codex/models (verified against the live backend).
    const m = mapCodexModel({
      slug: 'gpt-5.5',
      display_name: 'GPT-5.5',
      context_window: 272000,
      supported_in_api: true,
      visibility: 'list',
      input_modalities: ['text', 'image'],
      supports_parallel_tool_calls: true,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }],
    })
    expect(m.id).toBe('gpt-5.5')
    expect(m.name).toBe('GPT-5.5')
    expect(m.contextWindow).toBe(272000)
    expect(m.thinking?.efforts).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(m.supportsImageInput).toBe(true)
  })

  it('falls back to GPT-5 defaults when the entry omits reasoning/modalities', () => {
    const m = mapCodexModel({ slug: 'gpt-5.4-mini', supported_in_api: true, visibility: 'list' })
    expect(m.thinking?.efforts).toEqual(['low', 'medium', 'high'])
    expect(m.supportsImageInput).toBe(true)
    expect(m.name).toBe('gpt-5.4-mini')
  })

  it('drops reasoning levels the registry does not recognise', () => {
    const m = mapCodexModel({
      slug: 'x',
      supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'bogus' }, {}],
    })
    expect(m.thinking?.efforts).toEqual(['medium'])
  })
})

describe('openaiCodexProvider.chat request serialization', () => {
  it('omits unsupported max_output_tokens even when caller passes maxOutputTokens', async () => {
    const { config, cleanup } = createCodexAuthConfig()
    const originalFetch = globalThis.fetch
    let capturedBody: Record<string, unknown> | undefined
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return codexSseResponse()
    }) as typeof fetch

    try {
      const chunks = []
      for await (const chunk of openaiCodexProvider.chat(
        { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 400000 },
        basicRequest({ maxOutputTokens: 200 }),
        config,
      )) {
        chunks.push(chunk)
      }

      expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(true)
      expect(capturedBody).toBeDefined()
      expect(capturedBody).not.toHaveProperty('max_output_tokens')
      expect(capturedBody).not.toHaveProperty('max_completion_tokens')
      expect(capturedBody).not.toHaveProperty('max_tokens')
    } finally {
      globalThis.fetch = originalFetch
      cleanup()
    }
  })

  it('keeps supported Responses fields intact while omitting token cap fields', async () => {
    const { config, cleanup } = createCodexAuthConfig()
    const originalFetch = globalThis.fetch
    let capturedBody: Record<string, unknown> | undefined
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return codexSseResponse()
    }) as typeof fetch

    try {
      for await (const _chunk of openaiCodexProvider.chat(
        {
          id: 'gpt-5.5',
          name: 'GPT-5.5',
          contextWindow: 400000,
          thinking: { efforts: ['low', 'medium', 'high'] },
        },
        basicRequest({
          system: [{ type: 'text', text: 'Be concise.' }],
          thinkingEffort: 'high',
          maxOutputTokens: 123,
          tools: [{
            name: 'lookup',
            description: 'Look something up',
            inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
          }],
        }),
        config,
      )) {
        // Drain the stream so the request is issued.
      }

      expect(capturedBody).toMatchObject({
        model: 'gpt-5.5',
        stream: true,
        store: false,
        instructions: 'Be concise.',
        reasoning: { effort: 'high' },
      })
      expect(capturedBody?.input).toEqual([
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say ok' }] },
      ])
      expect(capturedBody?.tools).toEqual([{
        type: 'function',
        name: 'lookup',
        description: 'Look something up',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      }])
      expect(capturedBody).not.toHaveProperty('max_output_tokens')
    } finally {
      globalThis.fetch = originalFetch
      cleanup()
    }
  })

  it('allows helper-style one-shot requests with maxOutputTokens to complete against Codex serialization', async () => {
    const { config, cleanup } = createCodexAuthConfig()
    const originalFetch = globalThis.fetch
    let capturedBody: Record<string, unknown> | undefined
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      if ('max_output_tokens' in capturedBody || 'max_completion_tokens' in capturedBody || 'max_tokens' in capturedBody) {
        return new Response('unsupported token cap field', { status: 400 })
      }
      return codexSseResponse('helper prompt')
    }) as typeof fetch

    try {
      let text = ''
      let finishReason = 'unknown'
      for await (const chunk of openaiCodexProvider.chat(
        { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 400000 },
        basicRequest({
          system: [{ type: 'text', text: 'Write a short icon prompt.' }],
          maxOutputTokens: 200,
        }),
        config,
      )) {
        if (chunk.type === 'text-delta') text += chunk.text
        if (chunk.type === 'finish') finishReason = chunk.reason
      }

      expect(text).toBe('helper prompt')
      expect(finishReason).toBe('stop')
      expect(capturedBody).not.toHaveProperty('max_output_tokens')
    } finally {
      globalThis.fetch = originalFetch
      cleanup()
    }
  })
})

describe('codexAccountIdFromTokens', () => {
  function idToken(claims: Record<string, unknown>): string {
    const seg = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `header.${seg}.sig`
  }

  it('extracts chatgpt_account_id from the id_token claims', () => {
    const tokens: PkceTokenResponse = {
      accessToken: 'AT',
      raw: {},
      idToken: idToken({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_123' } }),
    }
    expect(codexAccountIdFromTokens(tokens)).toEqual({ accountId: 'acc_123' })
  })

  it('returns undefined when no id_token / account id is present', () => {
    expect(codexAccountIdFromTokens({ accessToken: 'AT', raw: {} })).toBeUndefined()
    expect(
      codexAccountIdFromTokens({ accessToken: 'AT', raw: {}, idToken: idToken({ sub: 'x' }) }),
    ).toBeUndefined()
  })
})
