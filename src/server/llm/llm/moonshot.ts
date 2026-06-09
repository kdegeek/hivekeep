/**
 * Moonshot AI (Kimi) LLM provider — OpenAI-compatible REST API at
 * `https://api.moonshot.ai/v1`.
 *
 * Moonshot exposes a fully OpenAI-compatible `/chat/completions` endpoint, so we
 * reuse the official `openai` SDK with a `baseURL` override for the chat stream
 * (message conversion, streaming tool calls, error mapping, usage all behave
 * like OpenAI). Model discovery uses the OpenAI-style `GET /models` endpoint.
 *
 * Unlike the bare OpenAI catalogue shape, Moonshot's `/models` enriches each
 * entry with authoritative capability metadata: `context_length`,
 * `supports_image_in`, `supports_video_in`, `supports_reasoning`. We READ those
 * fields (verified live against the API) and only fall back to id heuristics
 * when a field is absent, so a future model with a non-standard name still
 * classifies correctly.
 *
 * (Note: the `.cn` base URL is a different region with separate accounts; this
 * provider targets the global `.ai` platform.)
 *
 * Vision/image input: the API's `supports_image_in` is authoritative. This
 * matters — the flagship `kimi-k2.{5,6}` models set `supports_image_in: true`
 * but their ids contain no `vision` substring, so the id heuristic alone would
 * wrongly mark them text-only. The id heuristic (any id containing `vision`,
 * e.g. `moonshot-v1-{8k,32k,128k}-vision-preview`) is kept only as a fallback
 * for entries that omit the field.
 *
 * Reasoning: the API advertises `supports_reasoning: true` for `kimi-k2.{5,6}`,
 * but that flag does NOT confirm the model accepts the OpenAI-compatible
 * `reasoning_effort` request parameter — Moonshot may reason automatically via a
 * different mechanism. We have already hit 400s on other providers
 * (gpt-5-chat-latest, grok *-non-reasoning) by sending `reasoning_effort` to
 * models that reject it, and the param is currently untestable here (the test
 * account is balance-suspended). The safe default is therefore to NOT advertise
 * reasoning efforts for any Moonshot model (`thinking` left undefined), so the
 * effort gate in `chat()` never fires. The `reasoning_content` → thinking-delta
 * passthrough is kept regardless (harmless if the field is absent), so reasoning
 * summaries still stream through when the model emits them.
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
import type { ReasoningEffort } from 'openai/resources/shared'

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

const BASE_URL = 'https://api.moonshot.ai/v1'

// ─── Config schema ───────────────────────────────────────────────────────────

const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: 'apiKey',
    type: 'secret',
    label: 'API Key',
    required: true,
    placeholder: 'sk-…',
    description: 'Get one at https://platform.moonshot.ai/console/api-keys',
  },
]

// ─── Moonshot /models payload (subset we read) ───────────────────────────────

/**
 * Entry from `GET /models`. Beyond the bare OpenAI shape, Moonshot enriches each
 * entry with authoritative capability metadata, which we prefer over id
 * heuristics (see `inferContextWindow` / `inferImageInput`).
 *
 * @internal exported for tests.
 */
export interface MoonshotModel {
  id: string
  object?: string
  owned_by?: string
  /** Authoritative context window; preferred over the id-suffix heuristic. */
  context_length?: number
  /** Authoritative image-input flag; preferred over the `vision` id heuristic. */
  supports_image_in?: boolean
  /** Authoritative video-input flag (not yet modeled — image-in is what drives capability). */
  supports_video_in?: boolean
  /**
   * Whether the model reasons. NOTE: this does NOT imply it accepts the OpenAI
   * `reasoning_effort` request param, so it is deliberately not consumed yet
   * (see file header — `thinking` stays undefined).
   */
  supports_reasoning?: boolean
}

// ─── Metadata-driven model classification ────────────────────────────────────

/** Default context window when no family suffix matches. */
const DEFAULT_CONTEXT_WINDOW = 131_072

/**
 * Context-window fallback by family, used only when the API omits
 * `context_length`. The id suffix encodes the window (`-8k`, `-32k`, `-128k`);
 * the `kimi-k2*` flagship family ships a 256k window. First match wins; the
 * default (128k) catches `moonshot-v1-auto` and any unrecognised id.
 */
const CONTEXT_BY_PREFIX: Array<[RegExp, number]> = [
  [/kimi-k2/, 262_144],
  [/-8k/, 8_192],
  [/-32k/, 32_768],
  [/-128k/, 131_072],
]

/**
 * Prefer the API-provided `context_length`; fall back to the id-suffix heuristic
 * when it's absent.
 *
 * @internal exported for tests.
 */
export function inferContextWindow(model: MoonshotModel): number {
  if (typeof model.context_length === 'number' && model.context_length > 0) {
    return model.context_length
  }
  for (const [pattern, value] of CONTEXT_BY_PREFIX) {
    if (pattern.test(model.id)) return value
  }
  return DEFAULT_CONTEXT_WINDOW
}

/**
 * Vision support: prefer the API's authoritative `supports_image_in`. This is
 * what catches `kimi-k2.{5,6}` (image-capable but with no `vision` in the id).
 * Fall back to the id heuristic (the dedicated `moonshot-v1-*-vision-preview`
 * models contain `vision`) only when the field is absent.
 *
 * @internal exported for tests.
 */
export function inferImageInput(model: MoonshotModel): boolean {
  if (typeof model.supports_image_in === 'boolean') return model.supports_image_in
  return /vision/i.test(model.id)
}

/**
 * Map a Moonshot catalogue entry to a Hivekeep `LLMModel`, or null if it has no
 * id. Every model is classified as an `llm` capability. Image input is set from
 * the id (vision models), reasoning is deliberately left undefined (see file
 * header), and context windows are inferred from the id suffix.
 *
 * @internal exported for tests.
 */
export function mapModel(model: MoonshotModel): LLMModel | null {
  if (!model.id) return null

  const out: LLMModel = {
    id: model.id,
    name: model.id,
    contextWindow: inferContextWindow(model),
    // OpenAI-compatible upstreams cache prompts transparently; Moonshot
    // forwards cache hits in usage. No per-block cache control to send.
    supportsPromptCaching: true,
    supportsParallelTools: true,
    // No `thinking`: reasoning_effort support is unconfirmed — never send it.
  }
  if (inferImageInput(model)) out.supportsImageInput = true
  return out
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getApiKey(config: ProviderConfig): string {
  const apiKey = config['apiKey']
  if (!apiKey) throw new AuthError('Missing Moonshot API key')
  return apiKey
}

function createClient(config: ProviderConfig): OpenAI {
  return new OpenAI({
    apiKey: getApiKey(config),
    baseURL: BASE_URL,
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

function downgradeEffort(
  requested: ThinkingEffort,
  supported: readonly ThinkingEffort[],
): ThinkingEffort | undefined {
  const order: ThinkingEffort[] = ['low', 'medium', 'high', 'max']
  const idx = order.indexOf(requested)
  for (let i = idx; i >= 0; i--) {
    if (supported.includes(order[i]!)) return order[i]
  }
  return supported[0]
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
        | (ChatCompletionChunk.Choice['delta'] & {
            reasoning_content?: string | null
            reasoning?: string | null
          })
        | undefined
      // Moonshot surfaces reasoning summaries as `delta.reasoning_content` on
      // reasoning models; tolerate `delta.reasoning` for forward compat.
      const reasoning = delta?.reasoning_content ?? delta?.reasoning
      if (reasoning) {
        yield { type: 'thinking-delta', text: reasoning }
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

export const moonshotProvider: LLMProvider = {
  type: 'moonshot',
  displayName: 'Kimi',
  configSchema: CONFIG_SCHEMA,
  // Moonshot's OpenAI-compatible endpoint follows OpenAI's 128-tool cap.
  defaultMaxTools: 128,
  billing: 'per-token',

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    try {
      const apiKey = getApiKey(config)
      // GET /models is a lightweight credential probe — 200 with a model list
      // means the key is valid, 401/403 means it isn't. (Note: /models still
      // 200s even when the account is chat-suspended for billing, which is the
      // intended behaviour for a credential check.)
      const res = await fetch(`${BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (res.ok) return { valid: true }
      if (res.status === 401 || res.status === 403) {
        return { valid: false, error: 'Invalid Moonshot API key' }
      }
      return { valid: false, error: `Moonshot returned HTTP ${res.status}` }
    } catch (err) {
      const mapped = mapApiError(err)
      return { valid: false, error: mapped.message }
    }
  },

  async listModels(config: ProviderConfig): Promise<LLMModel[]> {
    const apiKey = getApiKey(config)
    let payload: { data?: MoonshotModel[] }
    try {
      const res = await fetch(`${BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new AuthError(`Moonshot rejected the API key (HTTP ${res.status})`)
        }
        throw new ProviderServerError(
          `Moonshot /models returned HTTP ${res.status}`,
          res.status,
        )
      }
      payload = (await res.json()) as { data?: MoonshotModel[] }
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

    // Reasoning: only send the OpenAI-compatible `reasoning_effort` string when
    // the model advertises reasoning support. Moonshot models never set
    // `thinking` (see file header), so this gate never fires — but it mirrors
    // the xAI/DeepSeek shape so the day Moonshot confirms support it's a
    // one-line metadata change in `mapModel`.
    if (request.thinkingEffort && model.thinking?.efforts?.length) {
      const chosen = downgradeEffort(request.thinkingEffort, model.thinking.efforts)
      if (chosen) {
        const effort = chosen === 'max' ? 'high' : chosen
        params.reasoning_effort = effort as ReasoningEffort
      }
    }

    if (request.metadata?.userId) {
      params.user = request.metadata.userId
    }

    return streamChat(client, params, request.signal)
  },
}
