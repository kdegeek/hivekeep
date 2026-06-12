/**
 * DeepSeek LLM provider — OpenAI-compatible REST API at
 * `https://api.deepseek.com`.
 *
 * DeepSeek exposes a fully OpenAI-compatible `/chat/completions` endpoint, so
 * we reuse the official `openai` SDK with a `baseURL` override for the chat
 * stream (message conversion, streaming tool calls, error mapping, usage all
 * behave like OpenAI). Model discovery uses the OpenAI-style `GET /models`
 * endpoint, which returns only model ids (`{object:'list', data:[{id,...}]}`)
 * — no modality, pricing, or context-window metadata. Context windows are
 * therefore inferred from family naming (small prefix table, never per-ID
 * hardcoding), mirroring `xai.ts` / `openai-key.ts`. The v4 family is 1M tokens.
 *
 * Reasoning: DeepSeek V4 is a dual-mode (Thinking / Non-Thinking) family and
 * thinking is ON by default. Verified live: v4-flash/pro reason without any
 * params, accept `reasoning_effort` across low/medium/high/max, and stream the
 * chain-of-thought as `reasoning_content`. So we advertise the full effort range
 * for the v4 family and forward `reasoning_effort` when one is requested.
 *
 * CRITICAL — because thinking is on by default, DeepSeek REQUIRES that a
 * replayed assistant *tool-call* message carries its `reasoning_content`
 * (400 "the reasoning_content in the thinking mode must be passed back to the
 * API"). The engine strips unsigned thinking before replay, so `assistantMessage`
 * re-adds it (real text when present, else an empty string, which the API
 * accepts). Without this, every multi-step tool-using turn breaks.
 *
 * Vision/image input: no DeepSeek model is multimodal, so every model is
 * text-only. Image content blocks are degraded to a text placeholder in
 * `userBlocksToContent` — sending an `image_url` part hard-400s on DeepSeek.
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
import { downgradeEffort } from '@/server/llm/llm/types'

const BASE_URL = 'https://api.deepseek.com'

// ─── Config schema ───────────────────────────────────────────────────────────

const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: 'apiKey',
    type: 'secret',
    label: 'API Key',
    required: true,
    placeholder: 'sk-…',
    description: 'Get one at https://platform.deepseek.com/api_keys',
  },
]

// ─── DeepSeek /models payload (subset we read) ───────────────────────────────

/**
 * Entry from `GET /models`. DeepSeek returns the bare OpenAI shape — only an
 * `id` is meaningful. No modality, pricing, or context-window fields are
 * exposed (see `inferContextWindow`).
 *
 * @internal exported for tests.
 */
export interface DeepSeekModel {
  id: string
  object?: string
  owned_by?: string
}

// ─── Model classification ────────────────────────────────────────────────────

/**
 * Map a DeepSeek catalogue entry to a Hivekeep `LLMModel`, or null if it has no
 * id. DeepSeek's `/models` exposes ONLY ids (no context/modality/reasoning), so
 * we return the bare model — context window, reasoning (efforts), vision and
 * pricing are filled by the model registry from models.dev (see
 * `model-metadata.md`). No more name-based heuristics here.
 *
 * @internal exported for tests.
 */
export function mapModel(model: DeepSeekModel): LLMModel | null {
  if (!model.id) return null

  const out: LLMModel = {
    id: model.id,
    name: model.id,
    // OpenAI-compatible upstreams cache prompts transparently; DeepSeek
    // forwards cache hits in usage. No per-block cache control to send.
    supportsPromptCaching: true,
    supportsParallelTools: true,
  }
  return out
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getApiKey(config: ProviderConfig): string {
  const apiKey = config['apiKey']
  if (!apiKey) throw new AuthError('Missing DeepSeek API key')
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
      // No DeepSeek model is multimodal — sending an `image_url` part hard-400s
      // ("unknown variant `image_url`, expected `text`"). Degrade to a text
      // placeholder so the turn proceeds text-only instead of crashing.
      parts.push({ type: 'text', text: '[image omitted — this model has no vision support]' })
    }
  }
  if (parts.length === 0) return null
  if (parts.length === 1 && parts[0]!.type === 'text') {
    return parts[0]!.text
  }
  return parts
}

/**
 * Build an OpenAI-compatible assistant message from hivekeep content blocks.
 *
 * DeepSeek V4 runs with thinking on by default and REJECTS a replayed assistant
 * *tool-call* message that has no `reasoning_content` (400 "the reasoning_content
 * in the thinking mode must be passed back to the API"). The engine strips
 * unsigned thinking before replay and DeepSeek's reasoning_content is unsigned,
 * so the real text is usually gone here — an empty string satisfies the
 * requirement (verified) and is ignored when thinking is off. We therefore set
 * `reasoning_content` on every tool-call message (real thinking text when a
 * thinking block is present, else ""), but never on plain text messages.
 *
 * @internal exported for tests.
 */
export function assistantMessage(
  blocks: HivekeepMessage['content'],
): ChatCompletionAssistantMessageParam & { reasoning_content?: string } {
  let text = ''
  let reasoning = ''
  const toolCalls: ChatCompletionMessageToolCall[] = []
  for (const b of blocks) {
    if (b.type === 'text') {
      text += b.text
    } else if (b.type === 'thinking') {
      reasoning += b.text
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
  // `reasoning_content` is a DeepSeek/OpenAI-compatible extension absent from the
  // upstream assistant-message type.
  const msg: ChatCompletionAssistantMessageParam & { reasoning_content?: string } = {
    role: 'assistant',
  }
  if (text) msg.content = text
  if (toolCalls.length > 0) {
    msg.tool_calls = toolCalls
    msg.reasoning_content = reasoning
  }
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
      // DeepSeek surfaces reasoning summaries as `delta.reasoning_content` on
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

export const deepseekProvider: LLMProvider = {
  type: 'deepseek',
  displayName: 'DeepSeek',
  configSchema: CONFIG_SCHEMA,
  // DeepSeek's OpenAI-compatible endpoint follows OpenAI's 128-tool cap.
  defaultMaxTools: 128,
  billing: 'per-token',

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    try {
      const apiKey = getApiKey(config)
      // GET /models is a lightweight credential probe — 200 with a model
      // list means the key is valid, 401/403 means it isn't.
      const res = await fetch(`${BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (res.ok) return { valid: true }
      if (res.status === 401 || res.status === 403) {
        return { valid: false, error: 'Invalid DeepSeek API key' }
      }
      return { valid: false, error: `DeepSeek returned HTTP ${res.status}` }
    } catch (err) {
      const mapped = mapApiError(err)
      return { valid: false, error: mapped.message }
    }
  },

  async listModels(config: ProviderConfig): Promise<LLMModel[]> {
    const apiKey = getApiKey(config)
    let payload: { data?: DeepSeekModel[] }
    try {
      const res = await fetch(`${BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new AuthError(`DeepSeek rejected the API key (HTTP ${res.status})`)
        }
        throw new ProviderServerError(
          `DeepSeek /models returned HTTP ${res.status}`,
          res.status,
        )
      }
      payload = (await res.json()) as { data?: DeepSeekModel[] }
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

    // Reasoning: forward `reasoning_effort` when the model advertises thinking
    // (the v4 family). DeepSeek natively accepts low/medium/high/max (verified),
    // so we send the chosen effort as-is rather than downgrading max→high.
    if (request.thinkingEffort && model.thinking?.efforts?.length) {
      const chosen = downgradeEffort(request.thinkingEffort, model.thinking.efforts)
      if (chosen) {
        params.reasoning_effort = chosen as ReasoningEffort
      }
    }

    if (request.metadata?.userId) {
      params.user = request.metadata.userId
    }

    return streamChat(client, params, request.signal)
  },
}
