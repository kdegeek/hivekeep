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
import { Replicate, ReplicateApiError, type ReplicateCollectionModel } from './replicateApi'

interface ReplicateConfig {
  apiToken?: string
}

// ─── Collection slugs Replicate curates publicly ────────────────────────────
//
// The plugin sources its model catalogue from Replicate's own curated
// collections (https://replicate.com/explore) — *not* a hardcoded list in
// this file. Replicate adds and removes models from these collections as
// the community evolves; the plugin's `listModels()` simply mirrors that.
const LLM_COLLECTION_SLUG = 'language-models'
const IMAGE_COLLECTION_SLUG = 'text-to-image'
const EMBEDDING_COLLECTION_SLUG = 'embedding-models'

/**
 * Pretty-print a Replicate model name. Replicate uses
 * `<owner>/<slug-with-dashes>` for IDs; the display name we surface to
 * KinBot uses the slug with dashes replaced by spaces, prefixed with the
 * description's first sentence when available.
 */
function displayNameOf(m: ReplicateCollectionModel): string {
  const base = m.name.replace(/-/g, ' ')
  // Capitalize each word for nicer UI display
  const capitalized = base
    .split(' ')
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ')
  return `${capitalized} (${m.owner})`
}

/**
 * Extract input parameter metadata from the model's OpenAPI schema, when
 * present. Many Replicate LLMs declare `max_tokens` / `max_new_tokens`
 * with a maximum that doubles as the model's effective output cap; some
 * declare `system_prompt` (signaling chat-instruct support).
 *
 * Best-effort: shape is loosely typed because every model's schema is
 * different. Returning undefined for unknowns is the design choice — the
 * SDK's LLMModel.contextWindow / maxOutput are both optional.
 */
function readSchemaInts(
  schema: Record<string, unknown> | undefined,
  fields: string[],
): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {}
  const props = (schema?.components as { schemas?: { Input?: { properties?: Record<string, { maximum?: number; default?: number }> } } })
    ?.schemas?.Input?.properties
  if (!props) return out
  for (const f of fields) {
    const prop = props[f]
    if (prop?.maximum != null) out[f] = prop.maximum
    else if (prop?.default != null && typeof prop.default === 'number') out[f] = prop.default
  }
  return out
}

function llmModelFrom(m: ReplicateCollectionModel): LLMModel {
  const schemaInts = readSchemaInts(m.latest_version?.openapi_schema, [
    'max_tokens',
    'max_new_tokens',
    'max_length',
  ])
  const maxOutput =
    schemaInts.max_new_tokens ?? schemaInts.max_tokens ?? schemaInts.max_length
  return {
    id: `${m.owner}/${m.name}`,
    name: displayNameOf(m),
    // contextWindow is left undefined — Replicate doesn't expose it
    // uniformly across community models. The SDK allows undefined.
    ...(typeof maxOutput === 'number' ? { maxOutput } : {}),
  }
}

function imageModelFrom(m: ReplicateCollectionModel): ImageModel {
  // Heuristic: detect models that accept an `image` input (= image-to-image
  // / inpainting). The Input schema lists every input property.
  const inputProps = (m.latest_version?.openapi_schema as {
    components?: { schemas?: { Input?: { properties?: Record<string, unknown> } } }
  })?.components?.schemas?.Input?.properties ?? {}
  const supportsImageInput =
    'image' in inputProps || 'image_url' in inputProps || 'init_image' in inputProps
  return {
    id: `${m.owner}/${m.name}`,
    name: displayNameOf(m),
    ...(supportsImageInput ? { supportsImageInput: true } : {}),
  }
}

function embeddingModelFrom(m: ReplicateCollectionModel): EmbeddingModel {
  // dimensions and maxInputTokens are both optional on EmbeddingModel —
  // we leave them undefined when the schema doesn't expose them.
  return {
    id: `${m.owner}/${m.name}`,
    name: displayNameOf(m),
  }
}

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

  async listModels(config: ProviderConfig): Promise<LLMModel[]> {
    const token = requireToken(config)
    const collection = await new Replicate(this.fetch, token).collection(
      LLM_COLLECTION_SLUG,
    )
    return collection.models.map(llmModelFrom)
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

  async listModels(config: ProviderConfig): Promise<ImageModel[]> {
    const token = requireToken(config)
    const collection = await new Replicate(this.fetch, token).collection(
      IMAGE_COLLECTION_SLUG,
    )
    return collection.models.map(imageModelFrom)
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

  async listModels(config: ProviderConfig): Promise<EmbeddingModel[]> {
    const token = requireToken(config)
    try {
      const collection = await new Replicate(this.fetch, token).collection(
        EMBEDDING_COLLECTION_SLUG,
      )
      return collection.models.map(embeddingModelFrom)
    } catch (err) {
      // Replicate sometimes 404s on this slug if the collection is empty
      // or renamed. Return [] so the UI surfaces "no models" rather than
      // crashing on the provider page.
      if (err instanceof ReplicateApiError && err.status === 404) return []
      throw err
    }
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
