/**
 * Google Gemini provider (Google AI Studio API key path).
 *
 * Talks directly to `generativelanguage.googleapis.com` with a raw fetch
 * + hand-rolled SSE parser — no `@google/generative-ai` SDK. The wire
 * format is small enough that wrapping the SDK would buy nothing and
 * historically the SDK has been awkward with Bun's fetch types.
 *
 * Vertex AI (the GCP enterprise endpoint with OAuth/service-account
 * auth) is intentionally NOT covered here. It's a different auth flow
 * deserving its own provider when a user needs it; the model catalogue
 * is the same so a `gemini-vertex` provider would share most of this
 * file's wire mapping.
 *
 * Note on subscriptions: Google's consumer "Gemini Advanced" / Google
 * One AI Premium plan does NOT expose API access. There's no
 * subscription path equivalent to anthropic-oauth or openai-codex.
 */

import type {
  ConfigField,
  ProviderConfig,
  AuthResult,
  FinishReason,
  Usage,
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
  LLMProvider,
  LLMModel,
  ChatRequest,
  ChatChunk,
  KinbotMessage,
  KinbotMessageBlock,
  SystemPrompt,
  KinbotTool,
  ThinkingEffort,
} from '@/server/llm/llm/types'

// ─── Config schema ───────────────────────────────────────────────────────────

const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: 'apiKey',
    type: 'secret',
    label: 'API Key',
    required: true,
    placeholder: 'AIza…',
    description: 'Get one at https://aistudio.google.com/apikey',
  },
]

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

// ─── Wire types ──────────────────────────────────────────────────────────────

interface GeminiTextPart {
  text: string
}
interface GeminiInlineDataPart {
  inlineData: { mimeType: string; data: string }
}
interface GeminiFunctionCallPart {
  functionCall: { name: string; args: Record<string, unknown> }
}
interface GeminiFunctionResponsePart {
  functionResponse: { name: string; response: Record<string, unknown> }
}
type GeminiPart =
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

interface GeminiToolDeclaration {
  functionDeclarations: Array<{
    name: string
    description: string
    parameters: Record<string, unknown>
  }>
}

interface GeminiGenerationConfig {
  temperature?: number
  maxOutputTokens?: number
  thinkingConfig?: {
    thinkingBudget?: number
    includeThoughts?: boolean
  }
}

interface GeminiRequest {
  contents: GeminiContent[]
  systemInstruction?: GeminiContent
  tools?: GeminiToolDeclaration[]
  generationConfig?: GeminiGenerationConfig
  toolConfig?: { functionCallingConfig?: { mode?: 'AUTO' | 'ANY' | 'NONE' } }
}

interface GeminiStreamChunk {
  candidates?: Array<{
    content?: GeminiContent
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    cachedContentTokenCount?: number
    thoughtsTokenCount?: number
    totalTokenCount?: number
  }
}

interface GeminiModelListing {
  models?: Array<{
    name: string
    displayName?: string
    description?: string
    inputTokenLimit?: number
    outputTokenLimit?: number
    supportedGenerationMethods?: string[]
  }>
}

// ─── Auth + error mapping ────────────────────────────────────────────────────

function requireApiKey(config: ProviderConfig): string {
  const k = config['apiKey']
  if (!k) throw new AuthError('Missing Google AI Studio API key')
  return k
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    'x-goog-api-key': apiKey,
    'Content-Type': 'application/json',
  }
}

function errorFromResponse(status: number, body: string): KinbotProviderError {
  // Gemini error envelope: { error: { code, message, status } }
  let message = body
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } }
    if (parsed.error?.message) message = parsed.error.message
  } catch { /* keep raw body */ }

  if (status === 401 || status === 403) return new AuthError(message)
  if (status === 429) return new RateLimitError(message)
  if (status >= 400 && status < 500) return new InvalidRequestError(message)
  return new ProviderServerError(message, status)
}

function wrapError(err: unknown): KinbotProviderError {
  if (err instanceof KinbotProviderError) return err
  if (err instanceof Error) return new NetworkError(err.message, err)
  return new NetworkError(String(err))
}

// ─── KinBot → Gemini conversions ─────────────────────────────────────────────

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return globalThis.btoa(binary)
}

function blockToParts(block: KinbotMessageBlock): GeminiPart[] {
  switch (block.type) {
    case 'text':
      return block.text ? [{ text: block.text }] : []
    case 'image':
      return [{
        inlineData: {
          mimeType: block.mediaType,
          data: uint8ToBase64(block.data),
        },
      }]
    case 'tool-use':
      return [{
        functionCall: {
          name: block.name,
          args: (block.args as Record<string, unknown>) ?? {},
        },
      }]
    case 'tool-result':
      // Gemini requires response to be an object — wrap string content
      // in { result: ... } for compatibility with downstream parsers.
      // Look up the tool name on the caller side; we encode it as
      // functionResponse.name. Because the SDK tool-result block only
      // carries toolUseId (not name), the chat() caller patches the
      // name in via a pre-pass — see messagesToGemini below.
      return [{
        functionResponse: {
          name: '__placeholder__',  // overridden by messagesToGemini
          response: { result: block.content },
        },
      }]
    case 'thinking':
      // Gemini doesn't accept thinking-replay on input; we drop it.
      return []
  }
}

/**
 * Convert KinBot's messages into Gemini's `contents` array. Gemini
 * uses `model` instead of `assistant` for the role, and tool results
 * need their `name` patched in from the preceding `tool-use` block.
 */
function messagesToGemini(messages: KinbotMessage[]): GeminiContent[] {
  // Build an id → name map for tool-use blocks so we can label the
  // matching tool-result functionResponse on the way out.
  const toolNameById = new Map<string, string>()
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const b of m.content) {
      if (b.type === 'tool-use') toolNameById.set(b.id, b.name)
    }
  }

  const out: GeminiContent[] = []
  for (const m of messages) {
    const parts: GeminiPart[] = []
    for (const b of m.content) {
      const ps = blockToParts(b)
      for (const p of ps) {
        if ('functionResponse' in p && b.type === 'tool-result') {
          const name = toolNameById.get(b.toolUseId) ?? 'unknown_tool'
          parts.push({ functionResponse: { name, response: p.functionResponse.response } })
        } else {
          parts.push(p)
        }
      }
    }
    if (parts.length === 0) continue
    out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts })
  }
  return out
}

function systemToGemini(system: SystemPrompt | undefined): GeminiContent | undefined {
  if (!system || system.length === 0) return undefined
  const text = system.map((b) => b.text).filter(Boolean).join('\n\n')
  if (!text) return undefined
  return { role: 'user', parts: [{ text }] }
}

function toolsToGemini(tools: KinbotTool[] | undefined): GeminiToolDeclaration[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    })),
  }]
}

/**
 * Translate KinBot's discrete thinking effort into Gemini's
 * `thinkingBudget` token count. Gemini accepts -1 (auto), 0
 * (disabled), or a positive integer. Mapping is approximate — the
 * exact budget that maps to "high" varies per model, so we pick
 * conservative numbers that scale roughly linearly.
 *
 * undefined → omit (Gemini default = auto for 2.5 Pro, off for Flash)
 */
function thinkingBudgetFor(effort: ThinkingEffort | undefined): number | undefined {
  if (!effort) return undefined
  switch (effort) {
    case 'low': return 1024
    case 'medium': return 4096
    case 'high': return 16384
    case 'max': return -1   // auto / unlimited
  }
}

// ─── SSE parser ──────────────────────────────────────────────────────────────

async function* parseSSE(response: Response): AsyncIterable<GeminiStreamChunk> {
  if (!response.body) {
    throw new ProviderServerError('Gemini returned an empty body', response.status)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const rawMessage = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const dataLines = rawMessage
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
        if (dataLines.length === 0) continue
        const payload = dataLines.join('\n')
        try {
          yield JSON.parse(payload) as GeminiStreamChunk
        } catch {
          // Malformed event — skip rather than abort.
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ─── Finish-reason mapping ───────────────────────────────────────────────────

function finishReasonFromGemini(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'STOP': return 'stop'
    case 'MAX_TOKENS': return 'length'
    case 'SAFETY':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content-filter'
    case 'RECITATION': return 'content-filter'
    case 'MALFORMED_FUNCTION_CALL': return 'error'
    default: return reason ? 'unknown' : 'stop'
  }
}

// ─── Stream → ChatChunk ──────────────────────────────────────────────────────

async function* streamGemini(
  modelId: string,
  apiKey: string,
  body: GeminiRequest,
  signal: AbortSignal | undefined,
): AsyncIterable<ChatChunk> {
  const url = `${API_BASE}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(apiKey),
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

  let usage: Usage = {}
  let finishReason: FinishReason = 'unknown'
  let sawFunctionCall = false
  let toolCallSeq = 0

  for await (const chunk of parseSSE(response)) {
    if (chunk.usageMetadata) {
      const um = chunk.usageMetadata
      usage = {
        ...(typeof um.promptTokenCount === 'number' ? { inputTokens: um.promptTokenCount } : {}),
        ...(typeof um.candidatesTokenCount === 'number' ? { outputTokens: um.candidatesTokenCount } : {}),
        ...(typeof um.cachedContentTokenCount === 'number'
          ? { inputTokenDetails: { cacheReadTokens: um.cachedContentTokenCount } }
          : {}),
        ...(typeof um.thoughtsTokenCount === 'number'
          ? { outputTokenDetails: { reasoningTokens: um.thoughtsTokenCount } }
          : {}),
      }
    }

    const candidate = chunk.candidates?.[0]
    if (!candidate) continue

    for (const part of candidate.content?.parts ?? []) {
      if ('text' in part && part.text) {
        yield { type: 'text-delta', text: part.text }
      } else if ('functionCall' in part && part.functionCall) {
        sawFunctionCall = true
        // Gemini doesn't return an id per call; mint one locally so
        // the engine can correlate the matching tool-result.
        const id = `gem_${Date.now().toString(36)}_${toolCallSeq++}`
        yield {
          type: 'tool-use',
          id,
          name: part.functionCall.name,
          args: part.functionCall.args ?? {},
        }
      }
      // inlineData / functionResponse parts shouldn't appear in
      // assistant turns — they're input-only. Skipped if seen.
    }

    if (candidate.finishReason) {
      finishReason = finishReasonFromGemini(candidate.finishReason)
    }
  }

  // Gemini's finish doesn't always set 'TOOL_CALLS' — when the
  // assistant turn contained a functionCall, override to 'tool-calls'.
  if (sawFunctionCall && finishReason === 'stop') {
    finishReason = 'tool-calls'
  }

  yield { type: 'finish', reason: finishReason, usage }
}

// ─── Model listing ───────────────────────────────────────────────────────────

/**
 * Fetch the catalogue from `GET /v1beta/models`, paginated under a
 * `pageToken` query. We keep only models that support
 * `streamGenerateContent` (the chat path) and strip the `models/`
 * URI prefix to leave the bare id KinBot uses everywhere.
 */
async function listGeminiModels(apiKey: string): Promise<LLMModel[]> {
  const out: LLMModel[] = []
  let pageToken: string | undefined
  do {
    const url = new URL(`${API_BASE}/models`)
    url.searchParams.set('pageSize', '100')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    let res: Response
    try {
      res = await fetch(url.toString(), { headers: authHeaders(apiKey) })
    } catch (err) {
      throw wrapError(err)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw errorFromResponse(res.status, text)
    }
    const payload = (await res.json()) as GeminiModelListing & { nextPageToken?: string }
    for (const m of payload.models ?? []) {
      const methods = m.supportedGenerationMethods ?? []
      if (!methods.includes('streamGenerateContent') && !methods.includes('generateContent')) continue
      const id = m.name.replace(/^models\//, '')
      // Multimodal models surface their capability via inputTokenLimit
      // alone — the official API doesn't expose an image-input flag.
      // Use a name heuristic: every 2.x+ Gemini accepts images.
      const supportsImageInput = /^gemini-(2|3)/.test(id)
      const model: LLMModel = {
        id,
        name: m.displayName ?? id,
        contextWindow: m.inputTokenLimit ?? 0,
        supportsImageInput,
        // Thinking is a model-level feature on the 2.5/3 series. The
        // public listing doesn't tag it, but the budget setting is
        // accepted on every 2.5+ model — we expose all 4 efforts and
        // let the budget mapping handle it.
        thinking: /^gemini-(2\.5|3)/.test(id)
          ? { efforts: ['low', 'medium', 'high', 'max'] }
          : undefined,
        // Implicit context cache on Gemini 2.5 (no per-request flag);
        // explicit caching exists via separate cachedContent API but
        // isn't yet wired.
        supportsPromptCaching: /^gemini-2\.5/.test(id),
        supportsParallelTools: true,
      }
      if (m.outputTokenLimit != null) model.maxOutput = m.outputTokenLimit
      out.push(model)
    }
    pageToken = payload.nextPageToken
  } while (pageToken)
  return out
}

// ─── Provider implementation ─────────────────────────────────────────────────

export const geminiProvider: LLMProvider = {
  type: 'gemini',
  displayName: 'Google Gemini',
  apiKeyUrl: 'https://aistudio.google.com/apikey',
  configSchema: CONFIG_SCHEMA,
  // Documented function-declaration cap is 128.
  defaultMaxTools: 128,
  billing: 'per-token',

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    const apiKey = config['apiKey']
    if (!apiKey) return { valid: false, error: 'Missing Google AI Studio API key' }
    try {
      // Lightweight probe: list one model. 401/403 surfaces an invalid
      // or expired key cleanly.
      const url = new URL(`${API_BASE}/models`)
      url.searchParams.set('pageSize', '1')
      const res = await fetch(url.toString(), { headers: authHeaders(apiKey) })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        const mapped = errorFromResponse(res.status, text)
        return { valid: false, error: mapped.message }
      }
      return { valid: true }
    } catch (err) {
      return { valid: false, error: wrapError(err).message }
    }
  },

  async listModels(config: ProviderConfig): Promise<LLMModel[]> {
    return listGeminiModels(requireApiKey(config))
  },

  chat(model, request: ChatRequest, config) {
    const apiKey = requireApiKey(config)

    const body: GeminiRequest = {
      contents: messagesToGemini(request.messages),
    }
    const system = systemToGemini(request.system)
    if (system) body.systemInstruction = system
    const tools = toolsToGemini(request.tools)
    if (tools) body.tools = tools

    const generationConfig: GeminiGenerationConfig = {}
    if (request.maxOutputTokens != null) generationConfig.maxOutputTokens = request.maxOutputTokens
    if (request.temperature != null) generationConfig.temperature = request.temperature
    const budget = thinkingBudgetFor(request.thinkingEffort)
    if (budget != null) generationConfig.thinkingConfig = { thinkingBudget: budget }
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig

    return streamGemini(model.id, apiKey, body, request.signal)
  },
}
