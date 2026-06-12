/**
 * OpenAI TTS provider — wraps `openai.audio.speech.create()`.
 *
 *   API:  POST https://api.openai.com/v1/audio/speech
 *   Docs: https://platform.openai.com/docs/api-reference/audio/createSpeech
 *
 * OpenAI exposes a fixed roster of voices (no /voices endpoint) usable
 * across three TTS models (`tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`).
 * We flatten the cartesian product into 9 × 3 = 27 Voice entries so the
 * picker exposes the quality tier and the model-specific feature
 * (e.g. `gpt-4o-mini-tts` is the only model that honors `instructions`).
 *
 * Voice id encoding: `{voice}@{model}` — parsed back in `speak()`. The
 * SDK declares `Voice.id` as provider-opaque, so this is fine.
 */

import OpenAI, { APIError } from 'openai'
import type {
  ProviderConfig,
  AuthResult,
} from '@/server/llm/core/types'
import {
  AuthError,
  RateLimitError,
  InvalidRequestError,
  NetworkError,
  ProviderServerError,
  HivekeepProviderError,
} from '@/server/llm/core/types'
import type {
  TTSProvider,
  Voice,
  SpeakRequest,
  SpeakResult,
} from '@/server/llm/tts/types'

const CONFIG_SCHEMA = [
  {
    key: 'apiKey',
    type: 'secret',
    label: 'API Key',
    required: true,
    placeholder: 'sk-…',
    description: 'OpenAI API key used for TTS.',
  },
] as const

type ModelTier = {
  id: 'tts-1' | 'tts-1-hd' | 'gpt-4o-mini-tts'
  label: string
  supportsInstructions: boolean
}

const MODELS: ModelTier[] = [
  { id: 'tts-1',            label: 'Standard',     supportsInstructions: false },
  { id: 'tts-1-hd',         label: 'HD',           supportsInstructions: false },
  { id: 'gpt-4o-mini-tts',  label: 'Instructable', supportsInstructions: true  },
]

// Roster of OpenAI voices. `description` is short on purpose — surfaced
// to the LLM through `list_voices` so it can pick the right tone.
const VOICES: Array<{ id: string; name: string; description: string }> = [
  { id: 'alloy',   name: 'Alloy',   description: 'Neutral, balanced.' },
  { id: 'ash',     name: 'Ash',     description: 'Warm, mellow.' },
  { id: 'ballad',  name: 'Ballad',  description: 'Soft, lyrical.' },
  { id: 'coral',   name: 'Coral',   description: 'Bright, energetic.' },
  { id: 'echo',    name: 'Echo',    description: 'Deep, calm male.' },
  { id: 'fable',   name: 'Fable',   description: 'British male, expressive.' },
  { id: 'nova',    name: 'Nova',    description: 'Young female, friendly.' },
  { id: 'onyx',    name: 'Onyx',    description: 'Authoritative male.' },
  { id: 'sage',    name: 'Sage',    description: 'Wise, measured.' },
  { id: 'shimmer', name: 'Shimmer', description: 'Soft, calming female.' },
]

function encodeVoiceId(voice: string, model: string): string {
  return `${voice}@${model}`
}

function decodeVoiceId(id: string): { voice: string; model: string } | null {
  const at = id.lastIndexOf('@')
  if (at <= 0) return null
  return { voice: id.slice(0, at), model: id.slice(at + 1) }
}

function createClient(config: ProviderConfig): OpenAI {
  const apiKey = config['apiKey']
  if (!apiKey) throw new AuthError('Missing OpenAI API key')
  return new OpenAI({ apiKey })
}

function mapApiError(err: unknown): HivekeepProviderError {
  if (err instanceof HivekeepProviderError) return err
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

function mediaTypeForFormat(format: string): string {
  switch (format) {
    case 'mp3':  return 'audio/mpeg'
    case 'wav':  return 'audio/wav'
    case 'opus': return 'audio/ogg'
    case 'pcm':  return 'audio/pcm'
    default:     return 'audio/mpeg'
  }
}

export const openaiTTSProvider: TTSProvider = {
  type: 'openai',
  displayName: 'OpenAI (TTS)',
  apiKeyUrl: 'https://platform.openai.com/api-keys',
  configSchema: CONFIG_SCHEMA,
  capabilities: {
    supportsStreaming: false,             // batch only in v1
    supportsSSML: false,
    supportsInstructions: true,           // honored when model = gpt-4o-mini-tts
    supportsSpeedControl: true,
    supportsLanguageOverride: false,      // voices are multilingual but no explicit override param
    supportedFormats: ['mp3', 'wav', 'opus', 'pcm'],
  },

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    try {
      const client = createClient(config)
      // /v1/models is the cheapest "key is valid" probe OpenAI exposes —
      // same approach the embedding provider uses.
      await client.models.list()
      return { valid: true }
    } catch (err) {
      return { valid: false, error: mapApiError(err).message }
    }
  },

  async listVoices(_config: ProviderConfig): Promise<Voice[]> {
    // Hardcoded — OpenAI doesn't expose a /voices endpoint. The cartesian
    // product (9 voices × 3 models = 30) is flattened so the picker
    // surfaces the quality tier explicitly.
    const out: Voice[] = []
    for (const v of VOICES) {
      for (const m of MODELS) {
        out.push({
          id: encodeVoiceId(v.id, m.id),
          name: `${v.name} (${m.label})`,
          description: m.supportsInstructions
            ? `${v.description} Supports natural-language style direction via 'instructions'.`
            : v.description,
          model: m.id,
        })
      }
    }
    return out
  },

  async speak(
    voice: Voice,
    request: SpeakRequest,
    config: ProviderConfig,
  ): Promise<SpeakResult> {
    const client = createClient(config)
    const warnings: string[] = []

    // Parse the encoded id; fall back to voice.model + raw id if the
    // host passes a bare voice (e.g. plugin author convenience).
    const parsed = decodeVoiceId(voice.id)
    const voiceName = parsed?.voice ?? voice.id
    const modelId = parsed?.model ?? voice.model ?? 'tts-1'

    const format = request.format ?? 'mp3'
    const speed = request.speed

    // OpenAI accepts speed 0.25-4.0; warn outside that range and clamp.
    let clampedSpeed: number | undefined = speed
    if (speed !== undefined) {
      if (speed < 0.25 || speed > 4.0) {
        warnings.push(
          `OpenAI TTS speed must be between 0.25 and 4.0 — value ${speed} clamped.`,
        )
        clampedSpeed = Math.max(0.25, Math.min(4.0, speed))
      }
    }

    // `instructions` is the gpt-4o-mini-tts knob; pass it through from
    // `extra.instructions`. Other models ignore it (we drop the field
    // before sending to avoid the API rejecting the unknown param).
    const instructions =
      typeof request.extra?.['instructions'] === 'string'
        ? (request.extra['instructions'] as string)
        : undefined
    if (instructions && modelId !== 'gpt-4o-mini-tts') {
      warnings.push(
        `OpenAI 'instructions' is only honored by gpt-4o-mini-tts; ignored for ${modelId}.`,
      )
    }

    try {
      const params: Parameters<typeof client.audio.speech.create>[0] = {
        model: modelId,
        voice: voiceName as never,  // typed enum upstream; the host validates the picker
        input: request.text,
        response_format: format as 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm',
        ...(clampedSpeed !== undefined ? { speed: clampedSpeed } : {}),
        ...(instructions && modelId === 'gpt-4o-mini-tts' ? { instructions } : {}),
      }

      const response = await client.audio.speech.create(params, { signal: request.signal })
      const arrayBuffer = await response.arrayBuffer()

      return {
        audio: new Uint8Array(arrayBuffer),
        mediaType: mediaTypeForFormat(format),
        ...(warnings.length ? { warnings } : {}),
      }
    } catch (err) {
      throw mapApiError(err)
    }
  },
}
