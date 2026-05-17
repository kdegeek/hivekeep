/**
 * OpenAI image generation provider.
 *
 * Talks to the official `openai` SDK. Supports the two model families OpenAI
 * exposes today: `gpt-image-*` (default modern family, accepts image input
 * for editing) and `dall-e-3` (text-to-image only, needs the explicit
 * `response_format: 'b64_json'` flag to return base64 rather than a URL).
 */

import OpenAI, { APIError, toFile } from 'openai'
import type {
  ConfigField,
  ProviderConfig,
  AuthResult,
} from '@/server/llm/core/types'
import {
  AuthError,
  RateLimitError,
  InvalidRequestError,
  NetworkError,
  ProviderServerError,
  KinbotProviderError,
} from '@/server/llm/core/types'
import type {
  ImageProvider,
  ImageModel,
  ImageRequest,
  ImageResult,
} from '@/server/llm/image/types'

const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: 'apiKey',
    type: 'secret',
    label: 'API Key',
    required: true,
    placeholder: 'sk-…',
    description: 'OpenAI API key used for image generation.',
  },
]

/** Image model families known to OpenAI today. Anything not matched falls
 *  through with conservative defaults. */
const KNOWN_MODELS: ImageModel[] = [
  {
    id: 'gpt-image-1',
    name: 'GPT Image 1',
    supportsImageInput: true,
    supportedSizes: ['1024x1024', '1024x1536', '1536x1024', 'auto'],
  },
  {
    id: 'dall-e-3',
    name: 'DALL·E 3',
    supportsImageInput: false,
    supportedSizes: ['1024x1024', '1024x1792', '1792x1024'],
  },
  {
    id: 'dall-e-2',
    name: 'DALL·E 2',
    supportsImageInput: true,
    supportedSizes: ['256x256', '512x512', '1024x1024'],
  },
]

function createClient(config: ProviderConfig): OpenAI {
  const apiKey = config['apiKey']
  if (!apiKey) throw new AuthError('Missing OpenAI API key')
  return new OpenAI({ apiKey })
}

function mapApiError(err: unknown): KinbotProviderError {
  if (err instanceof KinbotProviderError) return err
  if (err instanceof APIError) {
    const status = err.status
    const message = err.message
    if (status === 401 || status === 403) return new AuthError(message, err)
    if (status === 429) return new RateLimitError(message, undefined, err)
    if (status && status >= 400 && status < 500) return new InvalidRequestError(message, err)
    if (status && status >= 500) return new ProviderServerError(message, status, err)
    return new ProviderServerError(message, status, err)
  }
  if (err instanceof Error) return new NetworkError(err.message, err)
  return new NetworkError(String(err))
}

/** Filter the raw `/v1/models` listing to entries we recognise as image
 *  models. OpenAI's listing mixes every model the account can touch, so
 *  it's safest to match against our known set. */
function isImageModelId(id: string): boolean {
  if (id.startsWith('gpt-image')) return true
  if (id.startsWith('dall-e')) return true
  return false
}

export const openaiImageProvider: ImageProvider = {
  type: 'openai',
  displayName: 'OpenAI (Images)',
  configSchema: CONFIG_SCHEMA,

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    try {
      const client = createClient(config)
      await client.models.list()
      return { valid: true }
    } catch (err) {
      return { valid: false, error: mapApiError(err).message }
    }
  },

  async listModels(config: ProviderConfig): Promise<ImageModel[]> {
    const client = createClient(config)
    try {
      const page = await client.models.list()
      const seen = new Set<string>()
      const out: ImageModel[] = []
      for (const m of page.data) {
        if (!isImageModelId(m.id)) continue
        if (seen.has(m.id)) continue
        seen.add(m.id)
        const known = KNOWN_MODELS.find((k) => k.id === m.id)
        out.push(known ?? { id: m.id, name: m.id })
      }
      // Surface known models even when the listing is empty (some accounts
      // restrict /v1/models). Skip duplicates already added above.
      for (const k of KNOWN_MODELS) {
        if (!seen.has(k.id)) out.push(k)
      }
      return out
    } catch (err) {
      throw mapApiError(err)
    }
  },

  async generate(
    model: ImageModel,
    request: ImageRequest,
    config: ProviderConfig,
  ): Promise<ImageResult> {
    const client = createClient(config)
    const size = (request.size ?? '1024x1024') as '1024x1024'

    let response
    try {
      if (request.imageInput) {
        const file = await toFile(request.imageInput.data, 'input.png', {
          type: request.imageInput.mediaType,
        })
        response = await client.images.edit({
          model: model.id,
          image: file,
          prompt: request.prompt,
          size,
        }, { signal: request.signal })
      } else {
        const isDallE = model.id.startsWith('dall-e')
        response = await client.images.generate({
          model: model.id,
          prompt: request.prompt,
          size,
          ...(isDallE ? { response_format: 'b64_json' as const } : {}),
        }, { signal: request.signal })
      }
    } catch (err) {
      throw mapApiError(err)
    }

    const item = response.data?.[0]
    const base64 = item?.b64_json
    if (!base64) {
      throw new ProviderServerError('OpenAI image API returned no image data')
    }
    const bytes = base64ToUint8Array(base64)
    return { data: bytes, mediaType: 'image/png' }
  },
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = globalThis.atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
