import { describe, it, expect, mock } from 'bun:test'
import replicatePlugin from './index'
import type {
  ChatRequest,
  EmbeddingProvider,
  ImageProvider,
  LLMProvider,
  PluginContext,
} from '@kinbot-developer/sdk'

// ─── Fake ctx + canned HTTP responses ────────────────────────────────────────

interface FakeFetchCall {
  url: string
  init?: RequestInit
}

function makeCtx(): {
  ctx: PluginContext<{ apiToken?: string }>
  calls: FakeFetchCall[]
  pushResponse: (status: number, body: unknown, headers?: Record<string, string>) => void
} {
  const calls: FakeFetchCall[] = []
  const queue: Array<{ status: number; body: unknown; headers?: Record<string, string> }> = []

  return {
    calls,
    pushResponse: (status, body, headers) => {
      queue.push({ status, body, headers })
    },
    ctx: {
      config: { apiToken: 'r8_test_token' },
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      storage: {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
        list: async () => [],
        clear: async () => {},
      },
      http: {
        fetch: async (url: string, init?: RequestInit) => {
          calls.push({ url, init })
          const next = queue.shift()
          if (!next) throw new Error(`No canned response for ${url}`)
          const isJson = typeof next.body !== 'string' && !(next.body instanceof Uint8Array)
          return new Response(
            next.body instanceof Uint8Array
              ? next.body
              : typeof next.body === 'string'
                ? next.body
                : JSON.stringify(next.body),
            {
              status: next.status,
              headers: {
                'Content-Type': next.headers?.['Content-Type'] ?? (isJson ? 'application/json' : 'text/plain'),
                ...(next.headers ?? {}),
              },
            },
          )
        },
      },
      vault: {
        getSecret: async () => null,
        setSecret: async () => {},
        deleteSecret: async () => {},
        listKeys: async () => [],
      },
      manifest: { name: 'replicate', version: '0.1.0' },
      cards: {
        emit: mock(async () => ({ messageId: 'm', cardInstanceId: 'c' })),
        update: mock(async () => {}),
      },
    },
  }
}

function pickProvider<T>(
  plugin: ReturnType<typeof replicatePlugin>,
  guard: (p: any) => p is T,
): T {
  const found = plugin.providers!.find(guard)
  if (!found) throw new Error('provider not found')
  return found
}

const isLLM = (p: any): p is LLMProvider => typeof p?.chat === 'function'
const isImage = (p: any): p is ImageProvider => typeof p?.generate === 'function'
const isEmbed = (p: any): p is EmbeddingProvider => typeof p?.embed === 'function'

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('replicate plugin — exports', () => {
  it('contributes exactly three providers, one per family', () => {
    const plugin = replicatePlugin(makeCtx().ctx)
    expect(plugin.providers).toHaveLength(3)
    expect(plugin.providers!.some(isLLM)).toBe(true)
    expect(plugin.providers!.some(isImage)).toBe(true)
    expect(plugin.providers!.some(isEmbed)).toBe(true)
  })

  it('each provider shares the same `type: "replicate"` so the host can split them into rows per family', () => {
    const plugin = replicatePlugin(makeCtx().ctx)
    for (const p of plugin.providers!) {
      expect(p.type).toBe('replicate')
    }
  })

  it('exposes the API token URL on every provider', () => {
    const plugin = replicatePlugin(makeCtx().ctx)
    for (const p of plugin.providers!) {
      expect(p.apiKeyUrl).toBe('https://replicate.com/account/api-tokens')
    }
  })
})

describe('replicate plugin — LLM provider', () => {
  it('lists the curated LLM catalogue', async () => {
    const { ctx } = makeCtx()
    const llm = pickProvider(replicatePlugin(ctx), isLLM)
    const models = await llm.listModels(ctx.config as never)
    expect(models.length).toBeGreaterThan(0)
    expect(models.find((m) => m.id === 'meta/meta-llama-3-8b-instruct')).toBeDefined()
    expect(models.find((m) => m.id === 'mistralai/mixtral-8x7b-instruct-v0.1')).toBeDefined()
  })

  it('streams a single text-delta followed by a finish chunk', async () => {
    const { ctx, calls, pushResponse } = makeCtx()
    const llm = pickProvider(replicatePlugin(ctx), isLLM)

    // Replicate returns array-of-strings as output for these models.
    pushResponse(200, {
      id: 'pred_1',
      status: 'succeeded',
      output: ['Hello, ', 'KinBot!'],
      error: null,
      metrics: { input_token_count: 7, output_token_count: 3 },
    })

    const request: ChatRequest = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Say hi' }] },
      ],
      system: [{ type: 'text', text: 'You are concise.' }],
    }
    const stream = llm.chat(
      { id: 'meta/meta-llama-3-8b-instruct', name: 'Llama', contextWindow: 8192 },
      request,
      { apiToken: 'r8_test' },
    )

    const chunks = []
    for await (const c of stream) chunks.push(c)

    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual({ type: 'text-delta', text: 'Hello, KinBot!' })
    expect(chunks[1]?.type).toBe('finish')
    expect((chunks[1] as { usage: { inputTokens?: number } }).usage.inputTokens).toBe(7)

    // It went through the model-routed POST endpoint.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.replicate.com/v1/models/meta/meta-llama-3-8b-instruct/predictions')
    expect(calls[0]!.init?.method).toBe('POST')
    const sentBody = JSON.parse((calls[0]!.init?.body as string) ?? '{}')
    expect(sentBody.input.system_prompt).toBe('You are concise.')
    expect(sentBody.input.prompt).toContain('[INST] Say hi [/INST]')
  })

  it('authenticate hits /account and returns the username as accountLabel', async () => {
    const { ctx, calls, pushResponse } = makeCtx()
    const llm = pickProvider(replicatePlugin(ctx), isLLM)

    pushResponse(200, { username: 'marl', type: 'user' })

    const auth = await llm.authenticate({ apiToken: 'r8_test' })
    expect(auth.valid).toBe(true)
    expect(auth.accountLabel).toBe('marl')
    expect(calls[0]!.url).toBe('https://api.replicate.com/v1/account')
  })

  it('authenticate returns valid:false when the token is rejected', async () => {
    const { ctx, pushResponse } = makeCtx()
    const llm = pickProvider(replicatePlugin(ctx), isLLM)

    pushResponse(401, 'Unauthorized')

    const auth = await llm.authenticate({ apiToken: 'r8_bad' })
    expect(auth.valid).toBe(false)
    expect(auth.error).toContain('401')
  })

  it('chat throws when the prediction fails', async () => {
    const { ctx, pushResponse } = makeCtx()
    const llm = pickProvider(replicatePlugin(ctx), isLLM)

    pushResponse(200, {
      id: 'pred_x',
      status: 'failed',
      output: null,
      error: 'CUDA OOM',
    })

    const stream = llm.chat(
      { id: 'meta/meta-llama-3-8b-instruct', name: 'Llama', contextWindow: 8192 },
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      { apiToken: 'r8_test' },
    )
    await expect(async () => {
      for await (const _ of stream) {
        // drain
      }
    }).toThrow(/CUDA OOM/)
  })
})

describe('replicate plugin — Image provider', () => {
  it('runs a prediction and downloads the resulting image', async () => {
    const { ctx, calls, pushResponse } = makeCtx()
    const image = pickProvider(replicatePlugin(ctx), isImage)

    // 1) prediction (succeeded inline, no poll)
    pushResponse(200, {
      id: 'pred_img',
      status: 'succeeded',
      output: ['https://replicate.delivery/abc/image.png'],
      error: null,
    })
    // 2) image download
    pushResponse(200, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      'Content-Type': 'image/png',
    })

    const result = await image.generate(
      { id: 'black-forest-labs/flux-schnell', name: 'Flux' },
      { prompt: 'a friendly cat' },
      { apiToken: 'r8_test' },
    )

    expect(result.mediaType).toBe('image/png')
    expect(Array.from(result.data.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])

    // Two calls: prediction + download (the download went through ctx.http
    // too, so the manifest's `http:replicate.delivery` permission was the
    // actual gate).
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toContain('/predictions')
    expect(calls[1]!.url).toBe('https://replicate.delivery/abc/image.png')
  })

  it('listModels surfaces Flux + SD 3.5', async () => {
    const { ctx } = makeCtx()
    const image = pickProvider(replicatePlugin(ctx), isImage)
    const models = await image.listModels({ apiToken: 'r8_test' })
    expect(models.map((m) => m.id)).toContain('black-forest-labs/flux-schnell')
    expect(models.map((m) => m.id)).toContain('stability-ai/stable-diffusion-3.5-medium')
  })
})

describe('replicate plugin — Embedding provider', () => {
  it('returns a vector from a single text embed call', async () => {
    const { ctx, pushResponse } = makeCtx()
    const embed = pickProvider(replicatePlugin(ctx), isEmbed)

    pushResponse(200, {
      id: 'pred_emb',
      status: 'succeeded',
      output: [[0.01, 0.02, 0.03]],
      error: null,
    })

    const result = await embed.embed(
      { id: 'replicate/all-mpnet-base-v2', name: 'mpnet', dimensions: 768, maxInputTokens: 384 },
      { text: 'kinbot is great' },
      { apiToken: 'r8_test' },
    )

    expect(result.vector).toEqual([0.01, 0.02, 0.03])
  })

  it('unwraps a flat (non-nested) vector output too', async () => {
    const { ctx, pushResponse } = makeCtx()
    const embed = pickProvider(replicatePlugin(ctx), isEmbed)

    pushResponse(200, {
      id: 'pred_emb',
      status: 'succeeded',
      output: [0.1, 0.2, 0.3],
      error: null,
    })

    const result = await embed.embed(
      { id: 'replicate/all-mpnet-base-v2', name: 'mpnet', dimensions: 768, maxInputTokens: 384 },
      { text: 'kinbot' },
      { apiToken: 'r8_test' },
    )
    expect(result.vector).toEqual([0.1, 0.2, 0.3])
  })
})

describe('replicate plugin — permission auditing', () => {
  it('every HTTP call goes through ctx.http.fetch (not raw fetch)', async () => {
    const { ctx, calls, pushResponse } = makeCtx()
    const llm = pickProvider(replicatePlugin(ctx), isLLM)

    pushResponse(200, { username: 'marl' })
    await llm.authenticate({ apiToken: 'r8_test' })

    // The single call must have hit our fake ctx.http.fetch (recorded
    // in `calls`), proving the plugin doesn't reach for `globalThis.fetch`.
    expect(calls).toHaveLength(1)
  })

  it('no requests without an apiToken — surfaces a friendly error', async () => {
    const { ctx } = makeCtx()
    const llm = pickProvider(replicatePlugin(ctx), isLLM)
    const auth = await llm.authenticate({})
    expect(auth.valid).toBe(false)
    expect(auth.error).toContain('not configured')
  })
})
