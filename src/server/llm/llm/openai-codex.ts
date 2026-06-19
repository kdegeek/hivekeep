/**
 * OpenAI Codex CLI provider (ChatGPT Plus/Pro subscription).
 *
 * Talks directly to the Codex backend (`chatgpt.com/backend-api/codex`),
 * which exposes a Responses-style API billed against the user's ChatGPT
 * subscription. Auth is via OAuth tokens read from `~/.codex/auth.json`
 * (refreshed automatically); the model catalog is read from
 * `~/.codex/models_cache.json`, kept in sync by the Codex CLI itself.
 *
 * Uses raw fetch + a hand-rolled SSE parser rather than the official `openai`
 * SDK because the Codex backend's wire shape (proprietary URL, custom auth
 * headers, slightly different stream events) diverges from the standard
 * Responses API enough that pulling the SDK in would buy us nothing.
 *
 * Auth helpers live next door in `_codex-auth.ts` (underscore-prefixed so
 * the registry's `import.meta.glob` skips them).
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  getCodexOAuthCredentials,
  CODEX_BASE_URL,
  CODEX_PKCE_CLIENT,
  codexAccountIdFromTokens,
} from '@/server/llm/llm/_codex-auth'

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

// ─── Config schema ───────────────────────────────────────────────────────────

const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    // 'signin' = tokens obtained via the in-app PKCE flow, stored in the vault;
    // 'cli' (default for existing setups) = read ~/.codex/auth.json. Set by the
    // sign-in route; toggled by the UI. Non-secret, stored inline.
    key: 'authMode',
    type: 'text',
    label: 'Authentication mode',
    placeholder: 'cli',
    description: "Either 'signin' (in-app ChatGPT login) or 'cli' (read the Codex CLI auth file).",
  },
  {
    key: 'authFilePath',
    type: 'path',
    label: 'Codex auth file (optional)',
    placeholder: '~/.codex/auth.json',
    description:
      'Leave empty to auto-detect the Codex CLI credentials. Override only when running in a non-standard environment.',
  },
]

// ─── Model discovery ─────────────────────────────────────────────────────────

function getRealHome(): string {
  if (process.env.REAL_HOME) return process.env.REAL_HOME
  const home = process.env.HOME ?? ''
  const snapMatch = home.match(/^(\/home\/[^/]+)\/snap\//)
  if (snapMatch) return snapMatch[1]!
  if (process.env.USER) return `/home/${process.env.USER}`
  return home
}

const REAL_HOME = getRealHome()
const MODELS_CACHE_PATH = join(REAL_HOME, '.codex', 'models_cache.json')

interface CodexModelCacheEntry {
  slug: string
  display_name?: string
  visibility?: 'list' | 'hide' | string
  supported_in_api?: boolean
  priority?: number
  context_window?: number
  max_output_tokens?: number
  upgrade?: unknown
}

interface CodexModelsCacheFile {
  models?: CodexModelCacheEntry[]
}

/**
 * Read the Codex catalog from the on-disk cache maintained by the Codex CLI.
 * Returns null when the cache is missing or unreadable (so the caller can
 * decide whether to error out or fall back).
 */
function readCodexModelsFromCache(): CodexModelCacheEntry[] | null {
  try {
    if (!existsSync(MODELS_CACHE_PATH)) return null
    const raw = readFileSync(MODELS_CACHE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as CodexModelsCacheFile
    if (!parsed.models || !Array.isArray(parsed.models)) return null
    const filtered = parsed.models.filter(
      (m) =>
        typeof m.slug === 'string' &&
        m.slug.length > 0 &&
        m.supported_in_api === true &&
        m.visibility === 'list' &&
        m.upgrade == null,
    )
    filtered.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
    return filtered
  } catch {
    return null
  }
}

/**
 * Static fallback catalog used in CLI-free (sign-in) mode, or whenever the CLI
 * cache (`~/.codex/models_cache.json`) is absent. Without this, `listModels()`
 * hard-failed and the provider couldn't list a single model. The slugs are the
 * stable ids the Codex backend accepts; per-model metadata (context window,
 * pricing, label) is auto-filled from the model registry / models.dev, so the
 * coarse values here are only a floor for when enrichment is unavailable.
 */
export const STATIC_CODEX_MODELS: CodexModelCacheEntry[] = [
  { slug: 'gpt-5-codex', display_name: 'GPT-5-Codex', context_window: 400000, max_output_tokens: 128000, supported_in_api: true, visibility: 'list' },
  { slug: 'gpt-5', display_name: 'GPT-5', context_window: 400000, max_output_tokens: 128000, supported_in_api: true, visibility: 'list' },
]

/** Catalog entries from the CLI cache when present, else the static fallback. */
function resolveCodexModels(): CodexModelCacheEntry[] {
  return readCodexModelsFromCache() ?? STATIC_CODEX_MODELS
}

/**
 * Codex serves GPT-5 family reasoning models. Every model in the catalog
 * accepts `reasoning_effort` — the cache does not expose the supported
 * levels explicitly, so we assume the standard OpenAI set (no `max`).
 */
export function mapCodexModel(entry: CodexModelCacheEntry): LLMModel {
  const model: LLMModel = {
    id: entry.slug,
    name: entry.display_name && entry.display_name.length > 0 ? entry.display_name : entry.slug,
    contextWindow: entry.context_window ?? 0,
    supportsImageInput: true,
    supportsPromptCaching: true,
    supportsParallelTools: true,
    thinking: { efforts: ['low', 'medium', 'high'] },
  }
  if (entry.max_output_tokens != null) model.maxOutput = entry.max_output_tokens
  return model
}

// ─── Effort downgrade ────────────────────────────────────────────────────────


// ─── Error mapping ───────────────────────────────────────────────────────────

function errorFromResponse(status: number, body: string): HivekeepProviderError {
  if (status === 401 || status === 403) return new AuthError(`Codex auth failed: ${body.slice(0, 200)}`)
  if (status === 429) {
    return new RateLimitError(`Codex rate limit: ${body.slice(0, 200)}`)
  }
  // Context-overflow detection: match the actual OpenAI/Codex phrasings only
  // ("maximum context length", "context_length_exceeded", "input is too long"),
  // not any occurrence of the bare word "context" — schema-validation errors
  // routinely include strings like "In context=()" and used to be misclassified.
  if (
    status === 400 &&
    /(maximum (context|input) length|context[_ -]length[_ -]exceeded|input is too long|prompt is too long)/i.test(body)
  ) {
    return new ContextOverflowError(`Codex context overflow: ${body.slice(0, 200)}`)
  }
  if (status >= 400 && status < 500) {
    return new InvalidRequestError(`Codex bad request (${status}): ${body.slice(0, 200)}`)
  }
  return new ProviderServerError(`Codex server error (${status}): ${body.slice(0, 200)}`, status)
}

function wrapError(err: unknown): HivekeepProviderError {
  if (err instanceof HivekeepProviderError) return err
  if (err instanceof Error) return new NetworkError(err.message, err)
  return new NetworkError(String(err))
}

// ─── Message conversion (hivekeep → Codex Responses format) ────────────────────

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return globalThis.btoa(binary)
}

interface ResponseInputItem {
  type: string
  [key: string]: unknown
}

/**
 * Convert hivekeep messages to the Codex `input` array.
 *
 * The Codex Responses API expects a flat array where:
 *   - User text/image content → `{ type: 'message', role: 'user', content: [...] }`
 *   - Assistant text content → `{ type: 'message', role: 'assistant', content: [...] }`
 *   - Tool calls emitted by the assistant → `{ type: 'function_call', name, call_id, arguments }`
 *   - Tool results fed back in → `{ type: 'function_call_output', call_id, output }`
 *   - Thinking blocks → dropped (the backend round-trips its own reasoning
 *     via opaque encrypted blocks; we don't replay them).
 */
function messagesToCodexInput(messages: HivekeepMessage[]): ResponseInputItem[] {
  const items: ResponseInputItem[] = []
  for (const m of messages) {
    if (m.role === 'assistant') {
      const textParts: Array<{ type: 'output_text'; text: string }> = []
      for (const b of m.content) {
        if (b.type === 'text' && b.text) {
          textParts.push({ type: 'output_text', text: b.text })
        } else if (b.type === 'tool-use') {
          items.push({
            type: 'function_call',
            name: b.name,
            call_id: b.id,
            arguments: typeof b.args === 'string' ? b.args : JSON.stringify(b.args),
          })
        }
        // thinking blocks: dropped intentionally
      }
      if (textParts.length > 0) {
        items.push({
          type: 'message',
          role: 'assistant',
          content: textParts,
        })
      }
      continue
    }
    // user role
    const userParts: Array<Record<string, unknown>> = []
    for (const b of m.content) {
      if (b.type === 'text' && b.text) {
        userParts.push({ type: 'input_text', text: b.text })
      } else if (b.type === 'image') {
        const dataUrl = `data:${b.mediaType};base64,${uint8ToBase64(b.data)}`
        userParts.push({ type: 'input_image', image_url: dataUrl })
      } else if (b.type === 'tool-result') {
        items.push({
          type: 'function_call_output',
          call_id: b.toolUseId,
          output: b.content,
        })
      }
    }
    if (userParts.length > 0) {
      items.push({
        type: 'message',
        role: 'user',
        content: userParts,
      })
    }
  }
  return items
}

function systemToInstructions(system: ChatRequest['system']): string | undefined {
  if (!system || system.length === 0) return undefined
  const joined = system.map((b) => b.text).join('\n\n')
  return joined.length > 0 ? joined : undefined
}

interface ResponsesTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict?: boolean
}

function toolsToCodex(tools: ChatRequest['tools']): ResponsesTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }))
}

// ─── SSE parser ──────────────────────────────────────────────────────────────

/**
 * Parse a Server-Sent Events stream from a Response into a flow of decoded
 * `data:` JSON payloads. Skips empty lines, comment lines, and lone `event:`
 * lines (we only care about the JSON payloads).
 */
async function* parseSSE(response: Response): AsyncIterable<unknown> {
  if (!response.body) throw new ProviderServerError('Codex returned an empty body', response.status)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      // SSE message boundary is a blank line (\n\n).
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const rawMessage = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const dataLines = rawMessage
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
        if (dataLines.length === 0) continue
        const payload = dataLines.join('\n')
        if (payload === '[DONE]') return
        try {
          yield JSON.parse(payload)
        } catch {
          // Malformed event — skip rather than abort the whole stream.
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ─── Stream → ChatChunk ──────────────────────────────────────────────────────

interface CodexUsage {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
}

interface FunctionCallState {
  id: string
  name: string
  args: string
}

async function* streamCodex(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal | undefined,
): AsyncIterable<ChatChunk> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    throw wrapError(err)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw errorFromResponse(response.status, text)
  }

  const functionCalls = new Map<number, FunctionCallState>()
  let usage: Usage = {}
  let finishReason: FinishReason = 'unknown'

  try {
    for await (const raw of parseSSE(response)) {
      const event = raw as { type?: string; [key: string]: unknown }
      switch (event.type) {
        case 'response.output_item.added': {
          const item = event.item as { type?: string; name?: string; call_id?: string; output_index?: number } | undefined
          const outputIndex = (event.output_index as number | undefined) ?? 0
          if (item?.type === 'function_call' && item.name && item.call_id) {
            functionCalls.set(outputIndex, { id: item.call_id, name: item.name, args: '' })
          }
          break
        }
        case 'response.function_call_arguments.delta': {
          const outputIndex = (event.output_index as number | undefined) ?? 0
          const delta = (event.delta as string | undefined) ?? ''
          const state = functionCalls.get(outputIndex)
          if (state) state.args += delta
          break
        }
        case 'response.function_call_arguments.done': {
          const outputIndex = (event.output_index as number | undefined) ?? 0
          const args = (event.arguments as string | undefined) ?? ''
          const state = functionCalls.get(outputIndex)
          if (state) state.args = args
          break
        }
        case 'response.output_text.delta': {
          const delta = (event.delta as string | undefined) ?? ''
          if (delta) yield { type: 'text-delta', text: delta }
          break
        }
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta': {
          const delta = (event.delta as string | undefined) ?? ''
          if (delta) yield { type: 'thinking-delta', text: delta }
          break
        }
        case 'response.completed': {
          const resp = event.response as { usage?: CodexUsage; status?: string } | undefined
          const u = resp?.usage
          usage = {
            inputTokens: u?.input_tokens,
            outputTokens: u?.output_tokens,
            cacheReadTokens: u?.input_tokens_details?.cached_tokens,
            reasoningTokens: u?.output_tokens_details?.reasoning_tokens,
          }
          finishReason = functionCalls.size > 0 ? 'tool-calls' : 'stop'
          break
        }
        case 'response.failed':
        case 'response.error': {
          const resp = event.response as { error?: { message?: string } } | undefined
          const msg = resp?.error?.message ?? 'Codex stream failed'
          throw new ProviderServerError(msg)
        }
      }
    }
  } catch (err) {
    throw wrapError(err)
  }

  // Flush accumulated tool calls before the finish chunk.
  for (const state of functionCalls.values()) {
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

  yield { type: 'finish', reason: finishReason, usage }
}

// ─── Provider implementation ─────────────────────────────────────────────────

export const openaiCodexProvider: LLMProvider = {
  type: 'openai-codex',
  displayName: 'OpenAI (Codex CLI)',
  configSchema: CONFIG_SCHEMA,
  // Same upstream as openaiKeyProvider — OpenAI's 128-tool cap applies.
  defaultMaxTools: 128,
  // ChatGPT Plus / Codex CLI is a subscription — auto-resolution
  // prefers it over a metered openai-key when both serve the same model.
  billing: 'subscription',
  // Declares the in-app sign-in (PKCE). OpenAI redirects to a loopback URL the
  // user copies; buildExtra captures the ChatGPT account id from the id_token.
  oauth: { client: CODEX_PKCE_CLIENT, buildExtra: codexAccountIdFromTokens, redirectStyle: 'loopback' },

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    try {
      const { accessToken, accountId } = await getCodexOAuthCredentials(config)
      const testModel = resolveCodexModels()[0]?.slug
      if (!testModel) {
        return { valid: false, error: 'No Codex models available to test against.' }
      }
      // Lightweight ping with a short instruction; consumed and discarded.
      const response = await fetch(`${CODEX_BASE_URL}/responses`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'ChatGPT-Account-ID': accountId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: testModel,
          instructions: 'Reply with exactly one word.',
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] }],
          store: false,
          stream: true,
        }),
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        return { valid: false, error: errorFromResponse(response.status, text).message }
      }
      // Drain to avoid connection leak.
      if (response.body) {
        const reader = response.body.getReader()
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done } = await reader.read()
          if (done) break
        }
      }
      return { valid: true }
    } catch (err) {
      const mapped = wrapError(err)
      return { valid: false, error: mapped.message }
    }
  },

  async listModels(_config: ProviderConfig): Promise<LLMModel[]> {
    // CLI cache when present (file mode), else the static fallback so sign-in
    // (CLI-free) setups still list models without `codex login`.
    return resolveCodexModels().map(mapCodexModel)
  },

  chat(model, request, config) {
    const body: Record<string, unknown> = {
      model: model.id,
      input: messagesToCodexInput(request.messages),
      stream: true,
      store: false,
    }
    const instructions = systemToInstructions(request.system)
    if (instructions) body.instructions = instructions
    const tools = toolsToCodex(request.tools)
    if (tools) body.tools = tools
    if (request.thinkingEffort) {
      const chosen = downgradeEffort(request.thinkingEffort, model.thinking?.efforts ?? [])
      if (chosen) body.reasoning = { effort: chosen }
    }
    // Codex rejects max_output_tokens; max_completion_tokens is the Responses
    // equivalent, but the Codex backend caps it itself per-model — only set it
    // when the caller explicitly asked.
    if (request.maxOutputTokens != null) {
      body.max_output_tokens = request.maxOutputTokens
    }

    // Resolve credentials and stream. We do this inside the generator so a
    // token refresh happens lazily at first iteration rather than at the
    // (possibly long-lived) call site that constructed the iterator.
    return (async function* () {
      const { accessToken, accountId } = await getCodexOAuthCredentials(config)
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${accessToken}`,
        'ChatGPT-Account-ID': accountId,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      }
      yield* streamCodex(`${CODEX_BASE_URL}/responses`, headers, body, request.signal)
    })()
  },
}
