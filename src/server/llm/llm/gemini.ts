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
  HivekeepProviderError,
} from '@/server/llm/core/types'
import type {
  LLMProvider,
  LLMModel,
  ChatRequest,
  ChatChunk,
  HivekeepMessage,
  HivekeepMessageBlock,
  SystemPrompt,
  HivekeepTool,
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

/**
 * Names that match this pattern are filtered out of the LLM listing
 * even when they advertise `generateContent`. They're real Gemini
 * models, just not text-chat ones — Google reuses the `generateContent`
 * RPC for non-text modalities and the API doesn't tag the output
 * modality in the model record.
 *
 * - `image`  — image-generation models (Nano Banana family, native
 *              `*-image-preview`, `*-image-edit`, future
 *              `*-image-*` variants)
 * - `tts`    — text-to-speech preview models
 * - `aqa`    — Attributed Question Answering (grounded specialty)
 *
 * Embedding models (`text-embedding-*`, `embedding-001`,
 * `gemini-embedding-001`) are NOT in this pattern because they
 * already get filtered upstream — their `supportedGenerationMethods`
 * exposes only `embedContent`, never `generateContent`.
 *
 * Pattern, not allowlist: structural — when Google ships a future
 * model whose name contains one of these markers, it's automatically
 * filtered, no code change. A future `gemini-4-flash` chat model
 * passes through.
 */
const NON_LLM_MODALITY_PATTERN = /(^|[-_/])(image|tts|aqa)([-_]|$)/i

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

function errorFromResponse(status: number, body: string): HivekeepProviderError {
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

function wrapError(err: unknown): HivekeepProviderError {
  if (err instanceof HivekeepProviderError) return err
  if (err instanceof Error) return new NetworkError(err.message, err)
  return new NetworkError(String(err))
}

// ─── Hivekeep → Gemini conversions ─────────────────────────────────────────────

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return globalThis.btoa(binary)
}

function blockToParts(block: HivekeepMessageBlock): GeminiPart[] {
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
 * Convert Hivekeep's messages into Gemini's `contents` array. Gemini
 * uses `model` instead of `assistant` for the role, and tool results
 * need their `name` patched in from the preceding `tool-use` block.
 */
function messagesToGemini(messages: HivekeepMessage[]): GeminiContent[] {
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

/**
 * Gemini's function-declaration `parameters` field accepts only a
 * restricted OpenAPI-3.0 subset — NOT the rich JSON-Schema (draft
 * 2020-12) that zod v4's `z.toJSONSchema()` emits. Sending the raw
 * schema makes `generateContent`/`streamGenerateContent` 400 with
 * `Unknown name "$schema" / "additionalProperties" / "const" … :
 * Cannot find field`.
 *
 * This pure recursive sanitizer rebuilds the schema keeping ONLY the
 * keys Gemini understands, translating the constructs it can't express:
 *
 * - `format`            → kept only for the values Gemini supports
 *                         (`date-time` on strings; `int32`/`int64`/
 *                         `float`/`double` on numbers). All others
 *                         (`email`, `uuid`, `byte`, `int53`, …) dropped.
 * - `const`             → `enum: [value]` (single-value constraint).
 * - `.nullable()` idiom → `anyOf`/`oneOf` of exactly one real schema +
 *                         `{type:'null'}` collapses to the real schema
 *                         with `nullable: true`. `type: ['string','null']`
 *                         collapses the same way.
 * - other unions        → Gemini can't represent multi-branch unions in
 *                         function params; we degrade to the FIRST branch.
 * - everything else      (`$schema`, `additionalProperties`,
 *                         `propertyNames`, `default`, `pattern`,
 *                         `minimum`/`maximum`, `$ref`, `$defs`, …) is
 *                         dropped.
 *
 * Gemini-local: other providers accept the rich schema verbatim, so this
 * conversion lives here and is not shared.
 *
 * @internal exported for tests.
 */
export function sanitizeGeminiSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((el) => sanitizeGeminiSchema(el))
  if (node === null || typeof node !== 'object') return node

  const input = node as Record<string, unknown>

  // ── Collapse the nullable idiom / multi-branch unions ──────────────
  // anyOf/oneOf of [oneRealSchema, {type:'null'}] (in any order) → the
  // real schema + nullable:true. Other multi-branch unions degrade to
  // the first branch. allOf likewise degrades to its first branch.
  for (const unionKey of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = input[unionKey]
    if (Array.isArray(branches) && branches.length > 0) {
      const isNull = (b: unknown): boolean =>
        typeof b === 'object' && b !== null && (b as Record<string, unknown>)['type'] === 'null'
      const nonNull = branches.filter((b) => !isNull(b))
      const hadNull = nonNull.length < branches.length

      // Pick the schema to keep: first non-null branch, or first branch
      // if somehow all were null.
      const picked = (nonNull[0] ?? branches[0]) as unknown
      const sanitizedPick = sanitizeGeminiSchema(picked)
      const merged: Record<string, unknown> =
        sanitizedPick && typeof sanitizedPick === 'object' && !Array.isArray(sanitizedPick)
          ? { ...(sanitizedPick as Record<string, unknown>) }
          : {}

      // Preserve a description that lived on the union node itself.
      if (typeof input['description'] === 'string' && merged['description'] == null) {
        merged['description'] = input['description']
      }
      if (hadNull) merged['nullable'] = true
      return merged
    }
  }

  const out: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case 'type': {
        // type can be an array including 'null' → collapse to the single
        // real type + nullable:true.
        if (Array.isArray(value)) {
          const real = value.filter((t) => t !== 'null')
          if (value.includes('null')) out['nullable'] = true
          out['type'] = real[0] ?? 'object'
        } else {
          out['type'] = value
        }
        break
      }
      case 'description':
      case 'enum':
      case 'required':
      case 'nullable':
        out[key] = value
        break
      case 'properties': {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const props: Record<string, unknown> = {}
          for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
            props[propName] = sanitizeGeminiSchema(propSchema)
          }
          out['properties'] = props
        }
        break
      }
      case 'items': {
        out['items'] = sanitizeGeminiSchema(value)
        break
      }
      case 'format': {
        // Keep only formats Gemini's OpenAPI subset accepts.
        const GEMINI_FORMATS = new Set(['date-time', 'int32', 'int64', 'float', 'double'])
        if (typeof value === 'string' && GEMINI_FORMATS.has(value)) out['format'] = value
        break
      }
      case 'const': {
        // Preserve the single-value constraint as a one-element enum
        // (filtered to string below — Gemini enums are string-only).
        out['enum'] = [value]
        break
      }
      default:
        // Drop everything else: $schema, additionalProperties,
        // propertyNames, default, pattern, minimum/maximum, multipleOf,
        // min/maxLength, min/maxItems, $ref, $defs/definitions, $id,
        // $comment, title, examples, not, if/then/else, etc.
        break
    }
  }

  // Gemini `enum` only accepts STRING values (on a string-typed field). Drop any
  // non-string members (e.g. a boolean/number z.literal -> const). If none
  // remain, drop the enum entirely and keep the underlying type.
  if (Array.isArray(out['enum'])) {
    const strs = (out['enum'] as unknown[]).filter((v) => typeof v === 'string')
    if (strs.length > 0) {
      out['enum'] = strs
      out['type'] = 'string'
    } else {
      delete out['enum']
    }
  }

  return out
}

function toolsToGemini(tools: HivekeepTool[] | undefined): GeminiToolDeclaration[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return [{
    functionDeclarations: tools.map((t) => {
      const params = sanitizeGeminiSchema(t.inputSchema)
      // Gemini wants an object schema (or the field omitted). If the
      // sanitized params lost its `type`, default to an empty object
      // schema — always safe.
      const valid =
        params && typeof params === 'object' && !Array.isArray(params) && 'type' in (params as object)
          ? (params as Record<string, unknown>)
          : { type: 'object', properties: {} }
      return {
        name: t.name,
        description: t.description,
        parameters: valid,
      }
    }),
  }]
}

/**
 * Translate Hivekeep's discrete thinking effort into Gemini's
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
    case 'minimal': return 512
    case 'low': return 1024
    case 'medium': return 4096
    case 'high': return 16384
    case 'xhigh': return 24576
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
 * URI prefix to leave the bare id Hivekeep uses everywhere.
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
      // Google's /v1beta/models listing doesn't expose the model's
      // OUTPUT modality — every model that accepts `generateContent`
      // appears uniformly, including non-text ones (Nano Banana for
      // image gen, *-tts-* for text-to-speech, AQA grounded-QA, …).
      // Their naming convention is the only public discriminator, so
      // we filter by structural pattern in the model id — not by a
      // specific-model-id allowlist. A new chat model like
      // `gemini-3-flash` passes; a new image variant like
      // `gemini-3-flash-image-edit` is automatically dropped.
      if (NON_LLM_MODALITY_PATTERN.test(id)) continue
      // Context window + max output come from the genuine Gemini API
      // (inputTokenLimit/outputTokenLimit). Vision, reasoning and prompt
      // caching are filled by the model registry from models.dev — Gemini's
      // listing doesn't tag them and name heuristics drift.
      const model: LLMModel = {
        id,
        name: m.displayName ?? id,
        supportsParallelTools: true,
      }
      if (m.inputTokenLimit != null) model.contextWindow = m.inputTokenLimit
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
