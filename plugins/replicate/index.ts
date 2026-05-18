/**
 * KinBot plugin: Replicate.
 *
 * A single plugin that contributes three native providers:
 *   - LLMProvider        for Llama 3 / Mistral / Mixtral hosted on Replicate
 *   - ImageProvider      for Flux Schnell / Stable Diffusion 3.5
 *   - EmbeddingProvider  for general-purpose text embeddings
 *
 * Demonstrates that a third-party plugin can stand up *every* native
 * provider family with a single API key + ~250 lines of code. Models
 * are curated lists hardcoded here — Replicate hosts tens of thousands
 * of community models, so a `listModels()` returning all of them would
 * overwhelm KinBot's UI; this plugin's intent is to surface a useful
 * default set.
 *
 * NB: this provider does not currently stream tokens (Replicate
 * supports SSE on some LLMs but we keep things simple for the demo).
 * The chat() generator yields the entire response as one `text-delta`
 * chunk followed by a `finish`. Tool use is not advertised because
 * Replicate-hosted open models do not have a uniform tool-calling
 * format.
 */

import type {
  ChatChunk,
  ChatRequest,
  EmbedRequest,
  EmbedResult,
  EmbeddingModel,
  EmbeddingProvider,
  ImageModel,
  ImageProvider,
  ImageRequest,
  ImageResult,
  KinbotMessage,
  LLMModel,
  LLMProvider,
  PluginContext,
  PluginExports,
  ProviderConfig,
  SystemPrompt,
} from '@kinbot-developer/sdk'
import { Replicate, ReplicateApiError } from './replicateApi'

interface ReplicateConfig {
  apiToken?: string
}

// ─── Curated model catalogues ───────────────────────────────────────────────

const LLM_MODELS: LLMModel[] = [
  {
    id: 'meta/meta-llama-3-8b-instruct',
    name: 'Llama 3 8B Instruct',
    contextWindow: 8192,
    maxOutput: 4096,
  },
  {
    id: 'meta/meta-llama-3-70b-instruct',
    name: 'Llama 3 70B Instruct',
    contextWindow: 8192,
    maxOutput: 4096,
  },
  {
    id: 'mistralai/mixtral-8x7b-instruct-v0.1',
    name: 'Mixtral 8x7B Instruct',
    contextWindow: 32768,
    maxOutput: 4096,
  },
  {
    id: 'mistralai/mistral-7b-instruct-v0.2',
    name: 'Mistral 7B Instruct v0.2',
    contextWindow: 32768,
    maxOutput: 4096,
  },
]

const IMAGE_MODELS: ImageModel[] = [
  {
    id: 'black-forest-labs/flux-schnell',
    name: 'Flux Schnell (fast text-to-image)',
    supportedSizes: ['1024x1024', '1024x768', '768x1024'],
  },
  {
    id: 'black-forest-labs/flux-dev',
    name: 'Flux Dev (higher quality, slower)',
    supportedSizes: ['1024x1024', '1024x768', '768x1024'],
  },
  {
    id: 'stability-ai/stable-diffusion-3.5-medium',
    name: 'Stable Diffusion 3.5 Medium',
    supportedSizes: ['1024x1024', '1024x768', '768x1024'],
  },
]

const EMBEDDING_MODELS: EmbeddingModel[] = [
  {
    id: 'replicate/all-mpnet-base-v2',
    name: 'all-mpnet-base-v2 (768d)',
    dimensions: 768,
    maxInputTokens: 384,
  },
]

// ─── Helpers ────────────────────────────────────────────────────────────────

function requireToken(config: ProviderConfig): string {
  const token = config.apiToken
  if (!token) {
    throw new Error(
      'Replicate plugin is not configured. Add the API token in Settings → Providers.',
    )
  }
  return token
}

function flattenSystem(system: SystemPrompt | undefined): string {
  if (!system || system.length === 0) return ''
  return system.map((b) => b.text).join('\n\n')
}

/**
 * Replicate-hosted instruct models accept a plain `prompt` plus a separate
 * `system_prompt`. KinBot's `KinbotMessage[]` is richer than that (multi-
 * turn, tool use, images), so we squash it down to the conventional
 * `[INST] ... [/INST]` style — good enough for chat without tools, which
 * is the shape these models actually expect.
 */
function buildPrompt(messages: KinbotMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    const text = m.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')
    if (!text) continue
    if (m.role === 'user') {
      lines.push(`[INST] ${text} [/INST]`)
    } else {
      lines.push(text)
    }
  }
  return lines.join('\n')
}

function joinOutput(output: unknown): string {
  // Replicate LLMs return an array of strings (one per token-ish chunk)
  // or, less commonly, a single string. Normalize both.
  if (typeof output === 'string') return output
  if (Array.isArray(output)) return output.join('')
  return ''
}

function firstUrl(output: unknown): string | null {
  if (typeof output === 'string') return output
  if (Array.isArray(output) && typeof output[0] === 'string') return output[0]
  return null
}

// ─── LLM provider ───────────────────────────────────────────────────────────

class ReplicateLLMProvider implements LLMProvider {
  readonly type = 'replicate'
  readonly displayName = 'Replicate (LLM)'
  readonly apiKeyUrl = 'https://replicate.com/account/api-tokens'
  readonly configSchema = [
    {
      key: 'apiToken',
      type: 'secret',
      label: 'Replicate API Token',
      required: true,
      placeholder: 'r8_...',
      description:
        'Found at https://replicate.com/account/api-tokens. Used for every Replicate call (LLM, image, embedding).',
    },
  ] as const

  constructor(private readonly fetch: PluginContext['http']['fetch']) {}

  async authenticate(config: ProviderConfig) {
    try {
      const token = requireToken(config)
      const account = await new Replicate(this.fetch, token).account()
      return { valid: true, accountLabel: account.username ?? 'replicate' }
    } catch (err) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  async listModels(_config: ProviderConfig) {
    return LLM_MODELS
  }

  async *chat(
    model: LLMModel,
    request: ChatRequest,
    config: ProviderConfig,
  ): AsyncIterable<ChatChunk> {
    const token = requireToken(config)
    const client = new Replicate(this.fetch, token)
    const systemPrompt = flattenSystem(request.system)
    const prompt = buildPrompt(request.messages)

    const prediction = await client.runPrediction<string[] | string>(
      {
        model: model.id,
        input: {
          prompt,
          ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
          ...(request.maxOutputTokens
            ? { max_tokens: request.maxOutputTokens, max_new_tokens: request.maxOutputTokens }
            : {}),
          ...(request.temperature != null ? { temperature: request.temperature } : {}),
        },
      },
      { signal: request.signal },
    )

    const text = joinOutput(prediction.output)
    yield { type: 'text-delta', text }
    yield {
      type: 'finish',
      reason: 'stop',
      usage: {
        inputTokens: prediction.metrics?.input_token_count,
        outputTokens: prediction.metrics?.output_token_count,
      },
    }
  }
}

// ─── Image provider ─────────────────────────────────────────────────────────

class ReplicateImageProvider implements ImageProvider {
  readonly type = 'replicate'
  readonly displayName = 'Replicate (Image)'
  readonly apiKeyUrl = 'https://replicate.com/account/api-tokens'
  readonly configSchema = [
    {
      key: 'apiToken',
      type: 'secret',
      label: 'Replicate API Token',
      required: true,
      placeholder: 'r8_...',
    },
  ] as const

  constructor(private readonly fetch: PluginContext['http']['fetch']) {}

  async authenticate(config: ProviderConfig) {
    return new ReplicateLLMProvider(this.fetch).authenticate(config)
  }

  async listModels(_config: ProviderConfig) {
    return IMAGE_MODELS
  }

  async generate(
    model: ImageModel,
    request: ImageRequest,
    config: ProviderConfig,
  ): Promise<ImageResult> {
    const token = requireToken(config)
    const client = new Replicate(this.fetch, token)
    const [width, height] = (request.size ?? '1024x1024').split('x').map((n) => Number(n))

    const prediction = await client.runPrediction<string[] | string>(
      {
        model: model.id,
        input: {
          prompt: request.prompt,
          ...(width && height ? { width, height, aspect_ratio: `${width}:${height}` } : {}),
          output_format: 'png',
          num_outputs: 1,
        },
      },
      { signal: request.signal, timeoutMs: 5 * 60_000 },
    )

    const url = firstUrl(prediction.output)
    if (!url) {
      throw new Error('Replicate image generation returned no output URL')
    }

    // The signed delivery URLs live on replicate.delivery — the plugin
    // manifest grants `http:replicate.delivery` so ctx.http.fetch lets
    // them through.
    const imgRes = await this.fetch(url, { signal: request.signal })
    if (!imgRes.ok) {
      throw new Error(`Failed to download generated image: HTTP ${imgRes.status}`)
    }
    const buf = await imgRes.arrayBuffer()
    const mediaType = imgRes.headers.get('content-type') ?? 'image/png'
    return { data: new Uint8Array(buf), mediaType }
  }
}

// ─── Embedding provider ─────────────────────────────────────────────────────

class ReplicateEmbeddingProvider implements EmbeddingProvider {
  readonly type = 'replicate'
  readonly displayName = 'Replicate (Embedding)'
  readonly apiKeyUrl = 'https://replicate.com/account/api-tokens'
  readonly configSchema = [
    {
      key: 'apiToken',
      type: 'secret',
      label: 'Replicate API Token',
      required: true,
      placeholder: 'r8_...',
    },
  ] as const

  constructor(private readonly fetch: PluginContext['http']['fetch']) {}

  async authenticate(config: ProviderConfig) {
    return new ReplicateLLMProvider(this.fetch).authenticate(config)
  }

  async listModels(_config: ProviderConfig) {
    return EMBEDDING_MODELS
  }

  async embed(
    model: EmbeddingModel,
    request: EmbedRequest,
    config: ProviderConfig,
  ): Promise<EmbedResult> {
    const token = requireToken(config)
    const client = new Replicate(this.fetch, token)

    const prediction = await client.runPrediction<number[][] | number[]>(
      {
        model: model.id,
        input: { text: request.text },
      },
      { signal: request.signal },
    )

    let vector: number[]
    const out = prediction.output
    if (Array.isArray(out) && Array.isArray(out[0])) {
      vector = out[0] as number[]
    } else if (Array.isArray(out) && typeof out[0] === 'number') {
      vector = out as number[]
    } else {
      throw new ReplicateApiError(
        `Replicate embedding model ${model.id} returned an unexpected output shape`,
      )
    }
    return { vector }
  }
}

// ─── Plugin entry point ─────────────────────────────────────────────────────

export default function replicatePlugin(
  ctx: PluginContext<ReplicateConfig>,
): PluginExports {
  ctx.log.info('replicate plugin loaded')

  // Each provider takes the audited fetch from ctx — `http:api.replicate.com`
  // and `http:replicate.delivery` permissions in the manifest are what
  // makes that fetch succeed.
  const fetch = ctx.http.fetch

  return {
    providers: [
      new ReplicateLLMProvider(fetch),
      new ReplicateImageProvider(fetch),
      new ReplicateEmbeddingProvider(fetch),
    ],
    async activate() {
      ctx.log.info('replicate plugin activated')
    },
    async deactivate() {
      ctx.log.info('replicate plugin deactivated')
    },
  }
}
