/**
 * OpenRouter LLM provider — OpenAI-compatible aggregator.
 *
 * OpenRouter (https://openrouter.ai) exposes hundreds of models from many
 * upstreams behind a single OpenAI-compatible API at
 * `https://openrouter.ai/api/v1`. We reuse the official `openai` SDK with a
 * `baseURL` override for the chat stream (message conversion, streaming tool
 * calls, error mapping, usage all behave like OpenAI), and a direct fetch
 * for `GET /api/v1/models` so we can read OpenRouter's rich per-model
 * metadata (`context_length`, `architecture.input_modalities`,
 * `supported_parameters`, `pricing`).
 *
 * Unlike `openai-key.ts`, classification here is driven entirely by the
 * API metadata — never by name heuristics — because OpenRouter's catalogue
 * is heterogeneous (text/image/audio models, tool-capable vs completion-only,
 * reasoning vs not). See `mapModel`.
 */

import OpenAI, { APIError } from 'openai'
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionAssistantMessageParam,
  ChatCompletionUserMessageParam,
  ChatCompletionToolMessageParam,
  ChatCompletionSystemMessageParam,
  ChatCompletionContentPart,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions'

import type {
  ConfigField,
  ProviderConfig,
  AuthResult,
  Usage,
  FinishReason,
} from '@/server/llm/core/types'
import {
  AuthError,
  RateLimitError,
  ContextOverflowError,
  InvalidRequestError,
  NetworkError,
  ProviderServerError,
  HivekeepProviderError,
} from '@/server/llm/core/types'
import type {
  LLMProvider,
  LLMModel,
  ChatRequest,
  ChatChunk,
  HivekeepMessage,
  ThinkingEffort,
} from '@/server/llm/llm/types'
import { downgradeEffort } from '@/server/llm/llm/types'

const BASE_URL = 'https://openrouter.ai/api/v1'

// OpenRouter recommends these headers for request attribution. Purely
// cosmetic on their dashboard; safe to send on every call.
const ATTRIBUTION_HEADERS: Record<string, string> = {
  'HTTP-Referer': 'https://hivekeep.marlburrow.io',
  'X-Title': 'Hivekeep',
}

// ─── Config schema ───────────────────────────────────────────────────────────

const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: 'apiKey',
    type: 'secret',
    label: 'API Key',
    required: true,
    placeholder: 'sk-or-…',
    description: 'Get one at https://openrouter.ai/keys',
  },
]

// ─── OpenRouter /api/v1/models payload (subset we read) ──────────────────────

/** @internal exported for tests. */
export interface OpenRouterModel {
  id: string
  name?: string
  context_length?: number | null
  architecture?: {
    input_modalities?: string[]
    output_modalities?: string[]
  }
  pricing?: {
    prompt?: string
    completion?: string
    input_cache_read?: string
    input_cache_write?: string
  }
  supported_parameters?: string[]
  top_provider?: {
    context_length?: number | null
    max_completion_tokens?: number | null
  }
}

// ─── Metadata-driven model classification ────────────────────────────────────

/**
 * Vision support: OpenRouter exposes `architecture.input_modalities`. A
 * model accepts image blocks iff that array contains `"image"`.
 *
 * @internal exported for tests.
 */
export function inferImageInput(model: OpenRouterModel): boolean {
  return model.architecture?.input_modalities?.includes('image') ?? false
}

/**
 * Reasoning support: OpenRouter advertises `reasoning` in
 * `supported_parameters` for models that accept a reasoning effort. We map
 * that to Hivekeep's `low | medium | high` efforts (OpenRouter has no `max`).
 *
 * @internal exported for tests.
 */
export function inferThinking(model: OpenRouterModel): LLMModel['thinking'] | undefined {
  if (!model.supported_parameters?.includes('reasoning')) return undefined
  return { efforts: ['low', 'medium', 'high'] }
}

/**
 * Tool-calling support: models whose `supported_parameters` omit `tools`
 * are completion-only. We mark them `maxTools: 0` so the engine drops every
 * tool AND skips the tool-heavy system-prompt sections (otherwise the model
 * hallucinates JSON tool-call syntax). Tool-capable models return undefined
 * so they inherit the provider's `defaultMaxTools`.
 *
 * @internal exported for tests.
 */
export function inferMaxTools(model: OpenRouterModel): number | undefined {
  if (model.supported_parameters?.includes('tools')) return undefined
  return 0
}

/** OpenRouter prices in USD per token (string). Hivekeep's `LLMModel.pricing`
 *  is USD per million tokens. Convert, dropping absent / sentinel (`-1`,
 *  variable-router) values.
 *
 *  @internal exported for tests. */
export function convertPricing(model: OpenRouterModel): LLMModel['pricing'] | undefined {
  const p = model.pricing
  if (!p) return undefined
  const perMillion = (raw: string | undefined): number | undefined => {
    if (raw == null || raw === '') return undefined
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) return undefined
    return n * 1_000_000
  }
  const input = perMillion(p.prompt)
  const output = perMillion(p.completion)
  if (input == null && output == null) return undefined
  const pricing: NonNullable<LLMModel['pricing']> = {
    input: input ?? 0,
    output: output ?? 0,
  }
  const cacheRead = perMillion(p.input_cache_read)
  if (cacheRead != null) pricing.cacheRead = cacheRead
  const cacheWrite = perMillion(p.input_cache_write)
  if (cacheWrite != null) pricing.cacheWrite = cacheWrite
  return pricing
}

/**
 * A model is usable as a Hivekeep LLM iff it produces text output. OpenRouter
 * also lists image / audio generation models (Lyria, GPT Image, Nano Banana)
 * — those output `image`/`audio` only and are filtered out here.
 *
 * @internal exported for tests.
 */
export function isTextOutputModel(model: OpenRouterModel): boolean {
  const out = model.architecture?.output_modalities
  // Older / sparse entries may omit the field; assume text in that case.
  if (!out || out.length === 0) return true
  return out.includes('text')
}

/**
 * Map an OpenRouter catalogue entry to a Hivekeep `LLMModel`, or null if it
 * isn't a text-output chat model. Classification is purely metadata-driven.
 *
 * @internal exported for tests.
 */
export function mapModel(model: OpenRouterModel): LLMModel | null {
  if (!model.id) return null
  if (!isTextOutputModel(model)) return null

  const contextWindow = model.context_length ?? model.top_provider?.context_length ?? undefined

  const out: LLMModel = {
    id: model.id,
    name: model.name ?? model.id,
    // OpenAI-compatible upstreams cache transparently; OpenRouter forwards
    // cache hits in usage. No per-block cache control to send.
    supportsPromptCaching: true,
    supportsParallelTools: true,
  }
  if (contextWindow != null) out.contextWindow = contextWindow
  if (inferImageInput(model)) out.supportsImageInput = true
  const thinking = inferThinking(model)
  if (thinking) out.thinking = thinking
  const maxTools = inferMaxTools(model)
  if (maxTools != null) out.maxTools = maxTools
  const pricing = convertPricing(model)
  if (pricing) out.pricing = pricing
  return out
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getApiKey(config: ProviderConfig): string {
  const apiKey = config['apiKey']
  if (!apiKey) throw new AuthError('Missing OpenRouter API key')
  return apiKey
}

function createClient(config: ProviderConfig): OpenAI {
  return new OpenAI({
    apiKey: getApiKey(config),
    baseURL: BASE_URL,
    defaultHeaders: ATTRIBUTION_HEADERS,
  })
}

function mapFinishReason(
  reason: ChatCompletionChunk.Choice['finish_reason'],
): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop'
    case 'length':
      return 'length'
    case 'tool_calls':
    case 'function_call':
      return 'tool-calls'
    case 'content_filter':
      return 'content-filter'
    case null:
      return 'unknown'
    default:
      return 'unknown'
  }
}

function mapApiError(err: unknown): HivekeepProviderError {
  if (err instanceof HivekeepProviderError) return err
  if (err instanceof APIError) {
    const status = err.status
    const message = err.message
    if (status === 401 || status === 403) return new AuthError(message, err)
    if (status === 429) {
      const retryAfter = parseRetryAfter(err.headers?.['retry-after'])
      return new RateLimitError(message, retryAfter, err)
    }
    if (status === 400 && /context.length|maximum context|too long/i.test(message)) {
      return new ContextOverflowError(message, undefined, undefined, err)
    }
    if (status && status >= 400 && status < 500) {
      return new InvalidRequestError(message, err)
    }
    if (status && status >= 500) {
      return new ProviderServerError(message, status, err)
    }
    return new ProviderServerError(message, status, err)
  }
  if (err instanceof Error) {
    return new NetworkError(err.message, err)
  }
  return new NetworkError(String(err))
}

function parseRetryAfter(header: string | string[] | undefined): number | undefined {
  if (!header) return undefined
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.round(seconds * 1000)
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return undefined
}


function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return globalThis.btoa(binary)
}

// ─── Message conversion (hivekeep → OpenAI-compatible) ─────────────────────────

function systemPromptToMessage(
  system: ChatRequest['system'],
): ChatCompletionSystemMessageParam | undefined {
  if (!system || system.length === 0) return undefined
  const text = system.map((b) => b.text).join('\n\n')
  if (!text) return undefined
  return { role: 'system', content: text }
}

function userBlocksToContent(
  blocks: HivekeepMessage['content'],
): ChatCompletionUserMessageParam['content'] | null {
  const parts: ChatCompletionContentPart[] = []
  for (const b of blocks) {
    if (b.type === 'text' && b.text) {
      parts.push({ type: 'text', text: b.text })
    } else if (b.type === 'image') {
      const dataUrl = `data:${b.mediaType};base64,${uint8ToBase64(b.data)}`
      parts.push({ type: 'image_url', image_url: { url: dataUrl } })
    }
  }
  if (parts.length === 0) return null
  if (parts.length === 1 && parts[0]!.type === 'text') {
    return parts[0]!.text
  }
  return parts
}

function assistantMessage(
  blocks: HivekeepMessage['content'],
): ChatCompletionAssistantMessageParam {
  let text = ''
  const toolCalls: ChatCompletionMessageToolCall[] = []
  for (const b of blocks) {
    if (b.type === 'text') {
      text += b.text
    } else if (b.type === 'tool-use') {
      toolCalls.push({
        id: b.id,
        type: 'function',
        function: {
          name: b.name,
          arguments: typeof b.args === 'string' ? b.args : JSON.stringify(b.args),
        },
      })
    }
  }
  const msg: ChatCompletionAssistantMessageParam = { role: 'assistant' }
  if (text) msg.content = text
  if (toolCalls.length > 0) msg.tool_calls = toolCalls
  return msg
}

function messagesToOpenAI(
  messages: HivekeepMessage[],
  system: ChatCompletionSystemMessageParam | undefined,
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = []
  if (system) out.push(system)

  for (const m of messages) {
    if (m.role === 'assistant') {
      out.push(assistantMessage(m.content))
      continue
    }
    const userContent = userBlocksToContent(m.content)
    if (userContent !== null) {
      out.push({ role: 'user', content: userContent })
    }
    for (const b of m.content) {
      if (b.type === 'tool-result') {
        const toolMsg: ChatCompletionToolMessageParam = {
          role: 'tool',
          tool_call_id: b.toolUseId,
          content: b.content,
        }
        out.push(toolMsg)
      }
    }
  }
  return out
}

function toolsToOpenAI(tools: ChatRequest['tools']): ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }))
}

// ─── Streaming (OpenAI-compatible chunks → ChatChunk) ────────────────────────

interface ToolCallState {
  id: string
  name: string
  args: string
}

async function* streamChat(
  client: OpenAI,
  params: ChatCompletionCreateParamsStreaming,
  signal: AbortSignal | undefined,
): AsyncIterable<ChatChunk> {
  let stream
  try {
    stream = await client.chat.completions.create(params, { signal })
  } catch (err) {
    throw mapApiError(err)
  }

  const toolsByIndex = new Map<number, ToolCallState>()
  let finishReason: ChatCompletionChunk.Choice['finish_reason'] = null
  let usage: Usage = {}

  try {
    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
          cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
          reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens,
        }
      }

      const choice = chunk.choices[0]
      if (!choice) continue

      const delta = choice.delta as
        | (ChatCompletionChunk.Choice['delta'] & { reasoning?: string | null })
        | undefined
      // OpenRouter surfaces reasoning traces as `delta.reasoning` for
      // reasoning models (when include_reasoning is on).
      if (delta?.reasoning) {
        yield { type: 'thinking-delta', text: delta.reasoning }
      }
      if (delta?.content) {
        yield { type: 'text-delta', text: delta.content }
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index
          let state = toolsByIndex.get(idx)
          if (!state) {
            state = { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' }
            toolsByIndex.set(idx, state)
          }
          if (tc.id) state.id = tc.id
          if (tc.function?.name) state.name = tc.function.name
          if (tc.function?.arguments) state.args += tc.function.arguments
        }
      }
      if (choice.finish_reason) {
        finishReason = choice.finish_reason
      }
    }
  } catch (err) {
    throw mapApiError(err)
  }

  for (const state of toolsByIndex.values()) {
    if (!state.id || !state.name) continue
    let args: unknown = {}
    if (state.args.length > 0) {
      try {
        args = JSON.parse(state.args)
      } catch {
        args = { _raw: state.args }
      }
    }
    yield { type: 'tool-use', id: state.id, name: state.name, args }
  }

  yield {
    type: 'finish',
    reason: mapFinishReason(finishReason),
    usage,
  }
}

// ─── Provider implementation ─────────────────────────────────────────────────

export const openrouterProvider: LLMProvider = {
  type: 'openrouter',
  displayName: 'OpenRouter',
  configSchema: CONFIG_SCHEMA,
  // OpenRouter forwards to OpenAI-compatible upstreams; 128 is a safe cap.
  defaultMaxTools: 128,
  billing: 'per-token',

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    try {
      const apiKey = getApiKey(config)
      // GET /api/v1/key is a lightweight credential probe — 200 means the
      // key is valid; 401 means it isn't. /api/v1/models is public and
      // would NOT validate the key.
      const res = await fetch(`${BASE_URL}/key`, {
        headers: { Authorization: `Bearer ${apiKey}`, ...ATTRIBUTION_HEADERS },
      })
      if (res.ok) return { valid: true }
      if (res.status === 401 || res.status === 403) {
        return { valid: false, error: 'Invalid OpenRouter API key' }
      }
      return { valid: false, error: `OpenRouter returned HTTP ${res.status}` }
    } catch (err) {
      const mapped = mapApiError(err)
      return { valid: false, error: mapped.message }
    }
  },

  async listModels(config: ProviderConfig): Promise<LLMModel[]> {
    const apiKey = getApiKey(config)
    let payload: { data?: OpenRouterModel[] }
    try {
      const res = await fetch(`${BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}`, ...ATTRIBUTION_HEADERS },
      })
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new AuthError(`OpenRouter rejected the API key (HTTP ${res.status})`)
        }
        throw new ProviderServerError(`OpenRouter /models returned HTTP ${res.status}`, res.status)
      }
      payload = (await res.json()) as { data?: OpenRouterModel[] }
    } catch (err) {
      throw mapApiError(err)
    }

    const models: LLMModel[] = []
    for (const raw of payload.data ?? []) {
      const mapped = mapModel(raw)
      if (mapped) models.push(mapped)
    }
    return models
  },

  chat(model, request, config) {
    const client = createClient(config)
    const system = systemPromptToMessage(request.system)

    const params: ChatCompletionCreateParamsStreaming = {
      model: model.id,
      messages: messagesToOpenAI(request.messages, system),
      stream: true,
      stream_options: { include_usage: true },
    }

    const tools = toolsToOpenAI(request.tools)
    if (tools) params.tools = tools

    if (request.maxOutputTokens != null) {
      params.max_tokens = request.maxOutputTokens
    }
    if (request.temperature != null) {
      params.temperature = request.temperature
    }

    // Reasoning: OpenRouter's native knob is `reasoning: { effort }` (not in
    // the OpenAI SDK types — attach via an extra field). Only send it when
    // the model advertises reasoning support and a thinking effort was
    // requested.
    if (request.thinkingEffort && model.thinking?.efforts?.length) {
      const chosen = downgradeEffort(request.thinkingEffort, model.thinking.efforts)
      if (chosen) {
        const effort = chosen === 'max' ? 'high' : chosen
        ;(params as unknown as Record<string, unknown>)['reasoning'] = { effort }
      }
    }

    if (request.metadata?.userId) {
      params.user = request.metadata.userId
    }

    return streamChat(client, params, request.signal)
  },
}
