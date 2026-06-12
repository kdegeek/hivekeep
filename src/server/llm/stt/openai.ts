/**
 * OpenAI STT provider — wraps `openai.audio.transcriptions.create()`.
 *
 *   API:  POST https://api.openai.com/v1/audio/transcriptions
 *   Docs: https://platform.openai.com/docs/api-reference/audio/createTranscription
 *
 * Supports three transcription models:
 *   - whisper-1                 — original Whisper, broad language coverage
 *   - gpt-4o-transcribe         — newer, higher quality
 *   - gpt-4o-mini-transcribe    — cheaper variant of the above
 *
 * Whisper-family doesn't do speaker diarization (no per-segment speaker
 * labels), so we declare `supportsDiarization: false`. Timestamps are
 * supported via `response_format: verbose_json` + `timestamp_granularities`.
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
  STTProvider,
  TranscriptionModel,
  TranscribeRequest,
  TranscribeResult,
} from '@/server/llm/stt/types'

const CONFIG_SCHEMA = [
  {
    key: 'apiKey',
    type: 'secret',
    label: 'API Key',
    required: true,
    placeholder: 'sk-…',
    description: 'OpenAI API key used for transcription.',
  },
] as const

const KNOWN_MODELS: TranscriptionModel[] = [
  {
    id: 'whisper-1',
    name: 'Whisper v1',
    // Whisper is multilingual — no need to enumerate codes.
    maxAudioSeconds: 25 * 60,  // 25MB upload cap roughly = 25 min of 16kHz audio
  },
  {
    id: 'gpt-4o-transcribe',
    name: 'GPT-4o Transcribe',
    maxAudioSeconds: 25 * 60,
  },
  {
    id: 'gpt-4o-mini-transcribe',
    name: 'GPT-4o mini Transcribe',
    maxAudioSeconds: 25 * 60,
  },
]

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

function extensionForMediaType(mediaType: string): string {
  // OpenAI requires a filename so it can sniff the format. Mapping is
  // strict — unknown types fall back to .bin and OpenAI 400s with a
  // clear error.
  const map: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/oga': 'oga',
    'audio/flac': 'flac',
    'audio/mp4': 'mp4',
    'audio/m4a': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
  }
  return map[mediaType.toLowerCase()] ?? 'bin'
}

export const openaiSTTProvider: STTProvider = {
  type: 'openai',
  displayName: 'OpenAI (STT)',
  apiKeyUrl: 'https://platform.openai.com/api-keys',
  configSchema: CONFIG_SCHEMA,
  capabilities: {
    supportsLanguageHint: true,
    supportsAutoDetectLanguage: true,    // verbose_json populates `language`
    supportsDiarization: false,          // Whisper-family doesn't do speakers
    supportsTimestamps: true,            // via verbose_json + timestamp_granularities
    supportsPromptBiasing: true,
    supportedAudioFormats: [
      'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav',
      'audio/webm', 'audio/ogg', 'audio/oga', 'audio/flac',
      'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac',
    ],
    supportsStreaming: false,
  },

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    try {
      const client = createClient(config)
      await client.models.list()
      return { valid: true }
    } catch (err) {
      return { valid: false, error: mapApiError(err).message }
    }
  },

  async listModels(_config: ProviderConfig): Promise<TranscriptionModel[]> {
    // OpenAI's /v1/models doesn't reliably surface the transcription
    // models (account-tier dependent), so the catalogue is hardcoded.
    return KNOWN_MODELS
  },

  async transcribe(
    model: TranscriptionModel,
    request: TranscribeRequest,
    config: ProviderConfig,
  ): Promise<TranscribeResult> {
    const client = createClient(config)
    const warnings: string[] = []

    // Build a File the OpenAI SDK can stream — the audio bytes plus
    // a filename it can sniff for the codec.
    const ext = extensionForMediaType(request.audio.mediaType)
    if (ext === 'bin') {
      warnings.push(
        `Audio MIME type "${request.audio.mediaType}" not recognized; OpenAI may reject it.`,
      )
    }
    const file = new File([request.audio.data as BlobPart], `audio.${ext}`, {
      type: request.audio.mediaType,
    })

    // Request verbose_json when the caller wants language detection or
    // segment timestamps — otherwise the cheaper `json` shape is fine.
    const wantsVerbose = request.timestamps === true
    const responseFormat = wantsVerbose ? 'verbose_json' : 'json'

    try {
      // `stream: false` resolves the discriminated overload to the
      // non-streaming variant — without it TypeScript can't tell which
      // shape we want and demands the streaming-required props.
      const result = await client.audio.transcriptions.create(
        {
          file,
          model: model.id,
          response_format: responseFormat,
          stream: false,
          ...(request.lang ? { language: request.lang } : {}),
          ...(request.prompt ? { prompt: request.prompt } : {}),
          ...(wantsVerbose ? { timestamp_granularities: ['segment'] } : {}),
        },
        { signal: request.signal },
      )

      // The SDK return type is a union over the response_format values.
      // We narrow by reading expected fields defensively.
      const r = result as {
        text?: string
        language?: string
        duration?: number
        segments?: Array<{ start: number; end: number; text: string }>
      }

      const out: TranscribeResult = {
        text: r.text ?? '',
        ...(r.language ? { language: r.language } : {}),
        ...(r.duration ? { durationMs: Math.round(r.duration * 1000) } : {}),
        ...(r.segments && r.segments.length
          ? { segments: r.segments.map((s) => ({ start: s.start, end: s.end, text: s.text })) }
          : {}),
        ...(warnings.length ? { warnings } : {}),
      }

      if (request.diarize) {
        out.warnings = [
          ...(out.warnings ?? []),
          'OpenAI STT does not support diarization; the diarize hint was ignored.',
        ]
      }

      return out
    } catch (err) {
      throw mapApiError(err)
    }
  },
}
