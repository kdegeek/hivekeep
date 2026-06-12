/**
 * MiniMax LLM provider — OpenAI-compatible REST API at
 * `https://api.minimax.io/v1`.
 *
 * MiniMax exposes a fully OpenAI-compatible `/chat/completions` endpoint, so we
 * reuse the official `openai` SDK with a `baseURL` override for the chat stream
 * (message conversion, streaming tool calls, error mapping, usage all behave
 * like OpenAI). Model discovery uses the OpenAI-style `GET /v1/models`
 * endpoint, which returns only model ids (`{object:'list', data:[{id,...}]}`)
 * — no modality, pricing, or context-window metadata. Context windows are
 * therefore inferred from family naming (small prefix table defaulting high,
 * never per-ID hardcoding), mirroring `deepseek.ts` / `xai.ts`.
 *
 * Both of MiniMax's key types — `sk-cp-…` (Token Plan) and `sk-api-…`
 * (Pay-as-you-go) — authenticate against this SAME base URL with identical
 * `Authorization: Bearer` auth, so there is no key-type-specific handling.
 *
 * Reasoning (THE SPECIAL PART): MiniMax M-series models emit their reasoning
 * INLINE at the start of the assistant `content` wrapped in `<think>…</think>`,
 * followed by the real answer — there is NO separate `reasoning_content`
 * field (unlike DeepSeek). Example non-streaming content:
 *   "<think>\nThe user asks 2+2...\n</think>\n\nFour"
 * The streaming chat handler therefore strips the `<think>…</think>` wrapper
 * from the content stream (via `createThinkParser`, a small state machine that
 * tolerates tags split across chunks) and routes text inside the wrapper to
 * `thinking-delta` and text after `</think>` to `text-delta`. If no `<think>`
 * appears, content streams through as plain `text-delta`.
 *
 * IMPORTANT (verified live on MiniMax-M3): M3 streams its reasoning TWICE per
 * chunk — once in a dedicated `delta.reasoning` field AND once inline in
 * `delta.content` as `<think>…</think>` (identical text). To avoid emitting the
 * chain-of-thought twice, the handler prefers the dedicated field and, once it
 * has seen it, strips the `<think>` wrapper from content WITHOUT re-emitting its
 * interior (the answer after `</think>` always flows through). Models that only
 * stream `<think>` in content fall back to the parser's thinking output.
 *
 * Because reasoning has no `reasoning_effort` knob (the /models payload exposes
 * no thinking metadata and reasoning is implicit in the family), `thinking` is
 * left undefined on every model — so the effort gate in `chat()` never fires and
 * we never send `reasoning_effort` (which would 400 on a model that rejects it).
 *
 * Vision/image input: /models exposes no modality field, so it is inferred from
 * the id — MiniMax-M3 is multimodal (image input), the M2.x family is text-only.
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

const BASE_URL = 'https://api.minimax.io/v1'

// ─── Config schema ───────────────────────────────────────────────────────────

const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: 'apiKey',
    type: 'secret',
    label: 'API Key',
    required: true,
    placeholder: 'sk-…',
    description:
      'Both Token Plan (sk-cp-…) and Pay-as-you-go (sk-api-…) keys work. Get one at https://platform.minimax.io/user-center/basic-information/interface-key',
  },
]

// ─── MiniMax /models payload (subset we read) ────────────────────────────────

/**
 * Entry from `GET /v1/models`. MiniMax returns the bare OpenAI shape — only an
 * `id` is meaningful. No modality, pricing, or context-window fields are
 * exposed (see `inferContextWindow`).
 *
 * @internal exported for tests.
 */
export interface MiniMaxModel {
  id: string
  object?: string
  owned_by?: string
}

// ─── Model classification ────────────────────────────────────────────────────

/**
 * Map a MiniMax catalogue entry to a Hivekeep `LLMModel`, or null if it has no
 * id. MiniMax's `/models` exposes ONLY ids (no context/modality), so we return
 * the bare model — context window, vision (M3 is multimodal), reasoning and
 * pricing are filled by the model registry from models.dev (see
 * `model-metadata.md`). No more name-based heuristics here. The inline
 * `<think>` reasoning is a TRANSPORT concern and stays in the stream handler.
 *
 * @internal exported for tests.
 */
export function mapModel(model: MiniMaxModel): LLMModel | null {
  if (!model.id) return null

  const out: LLMModel = {
    id: model.id,
    name: model.id,
    // OpenAI-compatible upstreams cache prompts transparently; MiniMax
    // forwards cache hits in usage. No per-block cache control to send.
    supportsPromptCaching: true,
    supportsParallelTools: true,
    // No `thinking`: reasoning is inline <think>, never reasoning_effort.
  }
  return out
}

// ─── Inline <think> stream parser (THE SPECIAL PART) ─────────────────────────

/**
 * A routed chunk from the `<think>` parser: either reasoning (inside the
 * `<think>…</think>` wrapper) or answer text (after `</think>`, or any content
 * when no wrapper is present).
 *
 * @internal exported for tests.
 */
export type ThinkSegment =
  | { kind: 'thinking'; text: string }
  | { kind: 'answer'; text: string }

const OPEN_TAG = '<think>'
const CLOSE_TAG = '</think>'

/**
 * Length of the longest suffix of `buf` that is a (strict or full) prefix of
 * `tag`. Used to decide how much of a buffer to hold back at a chunk boundary:
 * a trailing fragment that could still grow into `tag` (e.g. `"<thi"` before
 * `"nk>"` arrives) must not be flushed yet. Returns 0 when no suffix could
 * begin the tag.
 */
function pendingTagPrefixLen(buf: string, tag: string): number {
  const max = Math.min(buf.length, tag.length)
  for (let len = max; len > 0; len--) {
    if (buf.endsWith(tag.slice(0, len))) return len
  }
  return 0
}

/**
 * Stateful parser that strips the inline `<think>…</think>` wrapper MiniMax
 * M-series prepend to the assistant content and routes the two regions apart.
 *
 * Tags may arrive SPLIT ACROSS CHUNKS (`"<thi"` then `"nk>"`, `"</thin"` then
 * `"k>"`), so each call buffers the minimal trailing fragment that could still
 * complete a tag and emits everything it is certain about. The leading
 * `<think>` is only recognised at the very START of the content (optionally
 * after whitespace) — once real answer text has been seen, stray `<think>`
 * substrings are treated as ordinary text and never re-enter reasoning mode.
 *
 * @internal exported for tests.
 */
export function createThinkParser(): {
  push(chunk: string): ThinkSegment[]
  flush(): ThinkSegment[]
} {
  // 'start'    — before any content: deciding whether it opens with <think>
  // 'thinking' — inside <think>…, waiting for </think>
  // 'answer'   — after </think>, or determined there is no wrapper
  let state: 'start' | 'thinking' | 'answer' = 'start'
  let buf = ''

  function push(chunk: string): ThinkSegment[] {
    buf += chunk
    const out: ThinkSegment[] = []

    // Loop because one chunk can resolve several transitions (e.g. a full
    // "<think>x</think>y" arriving at once).
    for (;;) {
      if (state === 'start') {
        // Skip leading whitespace without committing — the opening <think>
        // (when present) sits at the very start, possibly after a newline.
        const trimmedLead = buf.replace(/^\s+/, '')
        const consumedWs = buf.length - trimmedLead.length

        if (trimmedLead.length === 0) {
          // Only whitespace so far — hold it; it's either pre-<think> padding
          // or (if no wrapper) leading answer whitespace, decided later.
          return out
        }
        if (OPEN_TAG.startsWith(trimmedLead)) {
          // Buffer is a strict prefix of "<think>" (e.g. "<thi") — wait.
          return out
        }
        if (trimmedLead.startsWith(OPEN_TAG)) {
          // Opening tag complete. Drop the whitespace + tag, enter thinking.
          buf = buf.slice(consumedWs + OPEN_TAG.length)
          state = 'thinking'
          continue
        }
        // First real content is not "<think>" → no wrapper. Everything
        // (including the leading whitespace we held) is answer text.
        state = 'answer'
        continue
      }

      if (state === 'thinking') {
        const closeIdx = buf.indexOf(CLOSE_TAG)
        if (closeIdx !== -1) {
          // Emit reasoning up to the close tag, drop the tag, switch to answer.
          if (closeIdx > 0) out.push({ kind: 'thinking', text: buf.slice(0, closeIdx) })
          buf = buf.slice(closeIdx + CLOSE_TAG.length)
          state = 'answer'
          continue
        }
        // No close tag yet: emit everything except a trailing fragment that
        // could still grow into "</think>".
        const hold = pendingTagPrefixLen(buf, CLOSE_TAG)
        const emit = buf.slice(0, buf.length - hold)
        if (emit) out.push({ kind: 'thinking', text: emit })
        buf = buf.slice(buf.length - hold)
        return out
      }

      // state === 'answer': everything left is answer text.
      if (buf) out.push({ kind: 'answer', text: buf })
      buf = ''
      return out
    }
  }

  function flush(): ThinkSegment[] {
    const out: ThinkSegment[] = []
    if (!buf) return out
    if (state === 'thinking') {
      // Unterminated <think> at end of stream — treat the remainder as
      // reasoning rather than dropping it.
      out.push({ kind: 'thinking', text: buf })
    } else {
      // 'start' with leftover (whitespace-only or a dangling "<thi" prefix
      // that never completed) or 'answer' tail → answer text.
      out.push({ kind: 'answer', text: buf })
    }
    buf = ''
    return out
  }

  return { push, flush }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getApiKey(config: ProviderConfig): string {
  const apiKey = config['apiKey']
  if (!apiKey) throw new AuthError('Missing MiniMax API key')
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
  // The inline-<think> parser: routes delta.content into thinking vs answer.
  const think = createThinkParser()
  // MiniMax-M3 ALSO streams reasoning in a dedicated field; when it does, the
  // inline <think> interior is a verbatim duplicate and must not be emitted
  // twice. Once we've seen the dedicated field, suppress the parser's thinking.
  let sawDedicatedReasoning = false

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
      // MiniMax-M3 streams its reasoning in a dedicated `reasoning` field AND
      // inline in `content` as <think>…</think> (the same text). Prefer the
      // dedicated field; once seen, the <think> interior is a duplicate so we
      // strip the wrapper but don't re-emit it. (DeepSeek-style `reasoning_content`
      // is tolerated for forward-compat.)
      const reasoning = delta?.reasoning_content ?? delta?.reasoning
      if (reasoning) {
        sawDedicatedReasoning = true
        yield { type: 'thinking-delta', text: reasoning }
      }
      // The classic MiniMax path: reasoning inline in content as <think>…</think>.
      // The state machine separates it from the answer (tolerating tags split
      // across chunks); its thinking is suppressed when the dedicated field
      // already carried the reasoning, but the answer always flows through.
      if (delta?.content) {
        for (const seg of think.push(delta.content)) {
          if (seg.kind === 'thinking') {
            if (!sawDedicatedReasoning) yield { type: 'thinking-delta', text: seg.text }
          } else {
            yield { type: 'text-delta', text: seg.text }
          }
        }
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

  // Flush any buffered trailing fragment from the <think> parser (suppressing
  // duplicated thinking when the dedicated reasoning field already carried it).
  for (const seg of think.flush()) {
    if (seg.kind === 'thinking') {
      if (!sawDedicatedReasoning) yield { type: 'thinking-delta', text: seg.text }
    } else {
      yield { type: 'text-delta', text: seg.text }
    }
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

export const minimaxProvider: LLMProvider = {
  type: 'minimax',
  displayName: 'MiniMax',
  configSchema: CONFIG_SCHEMA,
  // MiniMax's OpenAI-compatible endpoint follows OpenAI's 128-tool cap.
  defaultMaxTools: 128,
  billing: 'per-token',

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    try {
      const apiKey = getApiKey(config)
      // GET /v1/models is a lightweight credential probe — 200 with a model
      // list means the key is valid, 401/403 means it isn't.
      const res = await fetch(`${BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (res.ok) return { valid: true }
      if (res.status === 401 || res.status === 403) {
        return { valid: false, error: 'Invalid MiniMax API key' }
      }
      return { valid: false, error: `MiniMax returned HTTP ${res.status}` }
    } catch (err) {
      const mapped = mapApiError(err)
      return { valid: false, error: mapped.message }
    }
  },

  async listModels(config: ProviderConfig): Promise<LLMModel[]> {
    const apiKey = getApiKey(config)
    let payload: { data?: MiniMaxModel[] }
    try {
      const res = await fetch(`${BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new AuthError(`MiniMax rejected the API key (HTTP ${res.status})`)
        }
        throw new ProviderServerError(
          `MiniMax /models returned HTTP ${res.status}`,
          res.status,
        )
      }
      payload = (await res.json()) as { data?: MiniMaxModel[] }
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
    // the model advertises reasoning support. MiniMax models never set
    // `thinking` (reasoning is inline <think>, not an effort knob — see file
    // header), so this gate never fires. It mirrors the deepseek/xai shape so
    // that if MiniMax ever exposes a reasoning_effort knob it's a one-line
    // metadata change in `mapModel`.
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
