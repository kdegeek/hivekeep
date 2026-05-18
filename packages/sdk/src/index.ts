/**
 * @kinbot-developer/sdk — public plugin surface for KinBot.
 *
 * A plugin's `index.ts` should import everything it needs from this module:
 *
 *   import { tool, z } from '@kinbot-developer/sdk'
 *   import type { PluginContext, PluginExports, ChannelAdapter } from '@kinbot-developer/sdk'
 *
 *   export default function (ctx: PluginContext): PluginExports {
 *     return {
 *       tools: {
 *         my_tool: {
 *           availability: ['main', 'sub-kin'],
 *           create: () => tool({
 *             description: '...',
 *             inputSchema: z.object({ name: z.string() }),
 *             execute: async ({ name }) => ({ greeting: `hi ${name}` }),
 *           }),
 *         },
 *       },
 *     }
 *   }
 *
 * The SDK exposes:
 *   - `tool()` / `asSchema()`  : tool helpers with INPUT inferred from schema
 *   - `z`                      : re-export of zod (so plugins don't ship their own copy)
 *   - Types for everything a plugin can declare: tools, channels, providers, hooks
 *
 * KinBot's plugin loader resolves this package against the host's installation,
 * so a plugin declaring `@kinbot-developer/sdk` as a peer dep gets the host's
 * version automatically. No KinBot internal imports needed.
 */

import { z } from 'zod'

export { z }

// ════════════════════════════════════════════════════════════════════════════
//  Tools
// ════════════════════════════════════════════════════════════════════════════

export type JSONValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JSONValue }
  | JSONValue[]

/**
 * A tool definition as seen by KinBot. `inputSchema` is typed as `unknown`
 * because it can be a zod schema, a JSON Schema object, or a wrapper exposing
 * `.jsonSchema`. KinBot normalizes via {@link asSchema} before any provider
 * sees it.
 *
 * The `INPUT` / `OUTPUT` generics exist for inference at the `tool({...})`
 * call site only — they are not enforced at runtime.
 */
export interface Tool<INPUT = any, OUTPUT = any> {
  description?: string
  inputSchema: unknown
  execute?: (
    args: INPUT,
    options?: { abortSignal?: AbortSignal },
  ) => OUTPUT | Promise<OUTPUT>
}

/**
 * Infer the parsed input type of a tool's `inputSchema`.
 *
 * - When the schema is a zod schema → `z.infer<SCHEMA>`.
 * - When the schema exposes a Vercel-style `_output` phantom field → that type.
 * - Fallback `unknown`.
 */
type InferToolInput<SCHEMA> =
  SCHEMA extends z.ZodType<infer T> ? T
  : SCHEMA extends { _output: infer O } ? O
  : unknown

/**
 * Declarative helper used by every tool definition. At runtime it is the
 * identity function — its only job is to give the call site typed inference
 * so the `execute` callback's first argument is strongly typed against the
 * `inputSchema`.
 */
export function tool<SCHEMA, OUTPUT = unknown>(definition: {
  description?: string
  inputSchema: SCHEMA
  execute?: (
    args: InferToolInput<SCHEMA>,
    options?: { abortSignal?: AbortSignal },
  ) => OUTPUT | Promise<OUTPUT>
}): Tool<InferToolInput<SCHEMA>, OUTPUT> {
  return definition as Tool<InferToolInput<SCHEMA>, OUTPUT>
}

export interface NormalizedSchema {
  /** JSON Schema (draft 2020-12) representation of the original input. */
  jsonSchema: Record<string, unknown>
}

/**
 * Normalize whatever `inputSchema` shape a tool was declared with into a
 * JSON Schema object.
 *
 * Recognizes:
 *   - A wrapper already exposing `.jsonSchema` (legacy `Schema` shape).
 *   - A zod schema (`_def` / `parse` / `safeParse`) — converted via
 *     `z.toJSONSchema()` from zod v4.
 *   - A plain JSON Schema object (`type` / `properties` / `$schema`).
 *
 * Falls back to `{ type: 'object', properties: {} }` when the input can't be
 * recognized — required by providers like OpenAI which reject schemas missing
 * `properties`.
 */
export function asSchema(input: unknown): NormalizedSchema {
  if (input != null && typeof input === 'object') {
    const obj = input as Record<string, unknown>

    if (
      'jsonSchema' in obj &&
      obj.jsonSchema &&
      typeof obj.jsonSchema === 'object'
    ) {
      return { jsonSchema: obj.jsonSchema as Record<string, unknown> }
    }

    if ('_def' in obj || 'parse' in obj || 'safeParse' in obj) {
      try {
        const schema = z.toJSONSchema(input as z.ZodTypeAny) as Record<string, unknown>
        return { jsonSchema: schema }
      } catch {
        // fall through to the minimal fallback
      }
    }

    if ('type' in obj || 'properties' in obj || '$schema' in obj) {
      return { jsonSchema: obj }
    }
  }
  return { jsonSchema: { type: 'object', properties: {} } }
}

// ─── Tool registration (what plugins put under `exports.tools`) ─────────────

/** Where a tool is available: a Kin's main conversation, a sub-Kin task, or both. */
export type ToolAvailability = 'main' | 'sub-kin'

/** Runtime context passed to a tool factory by KinBot when the tool is resolved. */
export interface ToolExecutionContext {
  kinId: string
  userId?: string
  taskId?: string
  /** Current task depth (1-based). Present only when executing inside a task. */
  taskDepth?: number
  isSubKin: boolean
  /** ID of the originating channel queue item (causal chain tracking). */
  channelOriginId?: string
  /** Cron ID when executing a cron-triggered task. */
  cronId?: string
  /** Ticket ID when executing a ticket-linked task. */
  ticketId?: string
}

export type ToolFactory = (ctx: ToolExecutionContext) => Tool<any, any>

/**
 * What a plugin returns for each entry of `exports.tools`. The `create`
 * factory is bound to a fresh `ToolExecutionContext` per Kin turn so the
 * tool can capture the right kinId / userId / taskId in its closure.
 */
export interface ToolRegistration {
  create: ToolFactory
  availability: ToolAvailability[]
  /** Disabled by default unless the Kin's toolConfig opts in. */
  defaultDisabled?: boolean
  readOnly?: boolean
  concurrencySafe?: boolean
  destructive?: boolean
  /** Optional gating predicate evaluated at resolve time. Return false to omit
   *  the tool from the resolved toolset for a particular context. */
  condition?: (ctx: ToolExecutionContext) => boolean
}

// ════════════════════════════════════════════════════════════════════════════
//  Channels
// ════════════════════════════════════════════════════════════════════════════

export interface ChannelAdapterMeta {
  displayName: string
  brandColor?: string
  iconUrl?: string
}

/**
 * Field declared by a channel adapter so the UI can render a dynamic
 * configuration form and the server can validate the payload before storing
 * it in `channels.platformConfig`.
 */
export interface ChannelConfigField {
  name: string
  label: string
  type: 'text' | 'password' | 'number' | 'select' | 'switch'
  default?: unknown
  required?: boolean
  placeholder?: string
  description?: string
  options?: string[] | { value: string; label: string }[]
  min?: number
  max?: number
}

export interface ChannelConfigSchema {
  fields: ChannelConfigField[]
}

export interface IncomingAttachment {
  /** Platform-specific file identifier (e.g. Telegram file_id, Discord CDN URL). */
  platformFileId: string
  mimeType?: string
  fileName?: string
  fileSize?: number
  /** Direct download URL if available. */
  url?: string
  /** Optional headers required for downloading (e.g. WhatsApp auth). */
  headers?: Record<string, string>
}

export interface IncomingMessage {
  platformUserId: string
  platformUsername?: string
  platformDisplayName?: string
  platformMessageId: string
  platformChatId: string
  content: string
  attachments?: IncomingAttachment[]
  /**
   * Free-form structured context provided by the adapter (modality, presence,
   * channel info, …). Persisted into the user message metadata under the
   * `channel` key and injected into the LLM prompt as a `<channel-context>`
   * block. Non-breaking: adapters can ignore this field.
   */
  metadata?: Record<string, unknown>
}

export type IncomingMessageHandler = (message: IncomingMessage) => Promise<void>

export interface OutboundAttachment {
  /** Local file path (absolute) or a public URL. */
  source: string
  mimeType: string
  fileName?: string
}

export interface OutboundMessageParams {
  chatId: string
  content: string
  replyToMessageId?: string
  attachments?: OutboundAttachment[]
  /** Locale of the Kin owner (`en`, `fr`, …). Adapters may use it to localize
   *  the `contextLine` they return. */
  locale?: string
}

export interface OutboundMessageResult {
  platformMessageId: string
  /** Optional already-translated context describing the transport
   *  (TTS mode, voice, target channel…) shown below the bubble. */
  contextLine?: string
  /** Optional structured info (mode, voice, channel name…) kept alongside
   *  `contextLine` for debug/audit. Not rendered directly. */
  deliveryMeta?: Record<string, unknown>
}

export interface ChannelAdapter {
  readonly platform: string
  readonly meta?: ChannelAdapterMeta
  readonly configSchema?: ChannelConfigSchema

  start(
    channelId: string,
    config: Record<string, unknown>,
    onMessage: IncomingMessageHandler,
  ): Promise<void>

  stop(channelId: string): Promise<void>

  sendMessage(
    channelId: string,
    config: Record<string, unknown>,
    params: OutboundMessageParams,
  ): Promise<OutboundMessageResult>

  /** Turn the inbound `metadata` blob into a short, already-localized line
   *  of context for the conversation UI (e.g. "Sent by Alice from #Gaming
   *  via voice"). Optional. */
  formatInboundContext?(
    metadata: Record<string, unknown>,
    locale: string,
  ): string | null

  /**
   * How the adapter handles identity switching when a channel is transferred
   * from one Kin to another (transfer_channel tool):
   *   - 'native': the adapter implements `onIdentityChange` and pushes the
   *     new Kin's display name (and avatar when supported) to the external
   *     platform. The core does NOT prefix outbound messages.
   *   - 'prefix': the adapter cannot switch identity natively. The core
   *     prepends "[Kin Name] " to every outbound text message.
   *   - 'none': neither identity change nor prefix. Use only when neither
   *     makes sense.
   *
   * Default when undefined: 'prefix' (safest, always informs the user).
   */
  readonly identitySwitchMode?: 'native' | 'prefix' | 'none'

  onIdentityChange?(
    channelId: string,
    config: Record<string, unknown>,
    newIdentity: {
      kinSlug: string
      kinName: string
      avatarUrl?: string
    },
  ): Promise<void>

  validateConfig(config: Record<string, unknown>): Promise<{ valid: boolean; error?: string }>

  getBotInfo(config: Record<string, unknown>): Promise<{ name: string; username?: string } | null>

  /** Optional typing indicator. Platforms that don't support it leave it unimplemented. */
  sendTypingIndicator?(
    channelId: string,
    config: Record<string, unknown>,
    chatId: string,
  ): Promise<void>

  /**
   * Handle an inbound HTTP webhook from the external platform. Called by
   * `POST /api/channels/plugin/:platform/webhook/:channelId`. The adapter
   * parses the request, validates the signature, and returns either an
   * IncomingMessage to inject into the Kin queue (or null to ignore the
   * event) along with the HTTP Response to send back to the platform.
   *
   * Adapters using long-lived connections (polling, WebSocket) don't need
   * this. Webhook-driven adapters (Twilio, …) implement it.
   */
  handleInboundWebhook?(
    channelId: string,
    config: Record<string, unknown>,
    req: Request,
  ): Promise<{ incoming: IncomingMessage | null; response: Response }>
}

// ════════════════════════════════════════════════════════════════════════════
//  Providers (native LLM / embedding / image)
// ════════════════════════════════════════════════════════════════════════════
//
// Plugins extend KinBot with new model providers by implementing one of the
// three native interfaces (`LLMProvider`, `EmbeddingProvider`,
// `ImageProvider`). KinBot's built-in providers (Anthropic, OpenAI, …) use
// the same interfaces — there is no separate "plugin shape" anymore.

/** Capability flags a provider declares. Implemented as the union of the
 *  three native interfaces below. */
export type ProviderCapability = 'llm' | 'embedding' | 'image' | 'rerank'

// ─── Config schema (provider-declared, UI-rendered) ─────────────────────────

/**
 * A single field a provider needs to accept from the user (API key, base URL,
 * auth file path, free-form text). The KinBot UI renders the form
 * dynamically from this list; the server validates the payload against it.
 *
 * Used both for plugin providers and built-in providers — same shape.
 */
export type ConfigField =
  | {
      key: string
      type: 'secret'
      label: string
      required?: boolean
      placeholder?: string
      description?: string
    }
  | {
      key: string
      type: 'path'
      label: string
      required?: boolean
      placeholder?: string
      description?: string
      default?: string
    }
  | {
      key: string
      type: 'url'
      label: string
      required?: boolean
      placeholder?: string
      description?: string
      default?: string
    }
  | {
      key: string
      type: 'text'
      label: string
      required?: boolean
      placeholder?: string
      description?: string
      default?: string
    }

/** Convenience alias for a provider's full config schema. Equivalent to
 *  `ConfigField[]` — kept as a named type so plugin manifests and UI code
 *  can refer to it as a single concept. */
export type ProviderConfigSchema = readonly ConfigField[]

/** Validated, decrypted provider config passed to every provider call.
 *  The shape is a key/value map matching the keys declared in the
 *  provider's `configSchema`. Values are `undefined` when not provided. */
export type ProviderConfig = Record<string, string | undefined>

// ─── Authentication ─────────────────────────────────────────────────────────

export interface AuthResult {
  valid: boolean
  error?: string
  /** Optional human-readable account identifier (e.g. "user@example.com",
   *  "ChatGPT Plus account #abc123"). Surfaced in the UI when present. */
  accountLabel?: string
}

// ─── LLM usage (token accounting) ───────────────────────────────────────────

/** Normalized token usage across providers. Every provider populates the
 *  fields it knows about; absent fields stay undefined rather than 0 (so the
 *  caller can tell "not reported" from "actually zero"). */
export interface Usage {
  inputTokens?: number
  outputTokens?: number
  /** Tokens served from the provider's prompt cache (Anthropic, OpenAI). */
  cacheReadTokens?: number
  /** Tokens written into the prompt cache (Anthropic explicit caching). */
  cacheWriteTokens?: number
  /** Thinking/reasoning tokens (Anthropic extended thinking, OpenAI o-series). */
  reasoningTokens?: number
}

export type FinishReason =
  | 'stop'
  | 'length'
  | 'tool-calls'
  | 'content-filter'
  | 'error'
  | 'aborted'
  | 'unknown'

// ─── Error hierarchy ────────────────────────────────────────────────────────

/** Base class for every error raised by a provider implementation. Always
 *  carries a stable `code` so callers can branch on the kind without
 *  sniffing error messages. */
export abstract class KinbotProviderError extends Error {
  abstract readonly code: string

  constructor(message: string, public override readonly cause?: unknown) {
    super(message)
    this.name = this.constructor.name
  }
}

/** Authentication failed: missing/invalid key, expired OAuth token, etc. */
export class AuthError extends KinbotProviderError {
  readonly code = 'AUTH_ERROR'
}

/** Provider rate limit hit. `retryAfterMs` is set when the provider returned one. */
export class RateLimitError extends KinbotProviderError {
  readonly code = 'RATE_LIMIT'
  constructor(
    message: string,
    public readonly retryAfterMs?: number,
    cause?: unknown,
  ) {
    super(message, cause)
  }
}

/** Request exceeds the model's context window. */
export class ContextOverflowError extends KinbotProviderError {
  readonly code = 'CONTEXT_OVERFLOW'
  constructor(
    message: string,
    public readonly contextWindow?: number,
    public readonly requestedTokens?: number,
    cause?: unknown,
  ) {
    super(message, cause)
  }
}

/** Request rejected by the provider (bad payload, unsupported feature, etc.). */
export class InvalidRequestError extends KinbotProviderError {
  readonly code = 'INVALID_REQUEST'
}

/** Network/transport error (timeout, DNS, TLS, connection reset). */
export class NetworkError extends KinbotProviderError {
  readonly code = 'NETWORK_ERROR'
}

/** Provider returned a server-side error (5xx, malformed response, etc.). */
export class ProviderServerError extends KinbotProviderError {
  readonly code = 'PROVIDER_SERVER_ERROR'
  constructor(
    message: string,
    public readonly status?: number,
    cause?: unknown,
  ) {
    super(message, cause)
  }
}

/** The provider implementation does not support the requested capability
 *  (e.g. embeddings on a chat-only provider). */
export class UnsupportedCapabilityError extends KinbotProviderError {
  readonly code = 'UNSUPPORTED_CAPABILITY'
}

// ─── UI metadata (optional hints for the "add provider" picker) ─────────────

/** Optional UI hints shared by every native provider interface. Mostly used
 *  by the AddProviderDialog to render the right copy and link the user to
 *  the right places. */
export interface ProviderUIHints {
  /** True when no API key is required (local model, auto-detected creds). */
  readonly noApiKey?: boolean
  /** True when the API key is optional (provider works without one). */
  readonly optionalApiKey?: boolean
  /** URL where users can obtain / manage their API key. */
  readonly apiKeyUrl?: string
}

// ─── LLM ────────────────────────────────────────────────────────────────────

export type ThinkingEffort = 'low' | 'medium' | 'high' | 'max'

/** Everything KinBot needs to know about an LLM model. Populated by the
 *  provider's `listModels()` — never hardcoded in consumer code. */
export interface LLMModel {
  id: string
  name: string
  /** Maximum input/context tokens the model accepts. Optional because
   *  some upstream APIs (e.g. Replicate's model catalogue) don't expose
   *  this for every model. Internal callers fall back to provider
   *  defaults or treat undefined as "unknown". */
  contextWindow?: number
  maxOutput?: number
  /** Hard limit on the number of tools the provider accepts per request.
   *  Undefined = no known limit. */
  maxTools?: number
  /** True when the model can accept image blocks in user messages. */
  supportsImageInput?: boolean
  /** True when the model supports provider-side prompt caching
   *  (Anthropic explicit cache_control, OpenAI auto-cache). */
  supportsPromptCaching?: boolean
  /** True when the model can emit parallel tool calls in a single turn. */
  supportsParallelTools?: boolean
  /** Thinking/reasoning support. Undefined or `efforts: []` = not supported. */
  thinking?: {
    efforts: ThinkingEffort[]
    /** Optional UI note about quirks (e.g. "reasons internally — setting may
     *  have no visible effect"). */
    note?: string
  }
  /** Token pricing in USD per million tokens. Used by the dashboard; never
   *  required for the chat call itself. */
  pricing?: {
    input: number
    output: number
    cacheRead?: number
    cacheWrite?: number
  }
}

/** Tool definition as seen by the provider. Internal kinbot code translates
 *  the plugin's `Tool` shape into this for each chat request. */
export interface KinbotTool {
  name: string
  description: string
  /** JSON Schema for the tool's input arguments. */
  inputSchema: Record<string, unknown>
  /** Provider-side cache hint (Anthropic). Ignored by providers that don't
   *  support per-tool cache control. */
  cacheControl?: { type: 'ephemeral' }
}

export type KinbotRole = 'user' | 'assistant'

export interface TextBlock {
  type: 'text'
  text: string
  cacheControl?: { type: 'ephemeral' }
}

export interface ImageBlock {
  type: 'image'
  /** Raw bytes. Providers handle base64-encoding internally. */
  data: Uint8Array
  /** MIME type, e.g. 'image/png', 'image/jpeg'. */
  mediaType: string
  cacheControl?: { type: 'ephemeral' }
}

export interface ToolUseBlock {
  type: 'tool-use'
  id: string
  name: string
  args: unknown
  cacheControl?: { type: 'ephemeral' }
}

export interface ToolResultBlock {
  type: 'tool-result'
  toolUseId: string
  /** Plain-text result. Structured results should be JSON-serialized by the
   *  caller before reaching this block. */
  content: string
  isError?: boolean
  cacheControl?: { type: 'ephemeral' }
}

export interface ThinkingBlock {
  type: 'thinking'
  text: string
  /** Opaque provider signature (Anthropic redacted_thinking, OpenAI
   *  reasoning summary) needed to replay the block on subsequent turns. */
  signature?: string
}

export type KinbotMessageBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock

export interface KinbotMessage {
  role: KinbotRole
  content: KinbotMessageBlock[]
}

/** System prompt as a list of text blocks. Multiple blocks let the caller
 *  place cache breakpoints at specific positions (Anthropic). Providers
 *  that don't support multi-block systems concatenate them with `\n\n`. */
export type SystemPrompt = TextBlock[]

export interface ChatRequest {
  messages: KinbotMessage[]
  system?: SystemPrompt
  tools?: KinbotTool[]
  thinkingEffort?: ThinkingEffort
  maxOutputTokens?: number
  temperature?: number
  /** Optional abort signal to cancel the stream. */
  signal?: AbortSignal
  /** Free-form metadata forwarded to the provider when it supports it
   *  (Anthropic `metadata.user_id`). Never logged. */
  metadata?: { userId?: string }
}

/** The provider's `chat()` returns an AsyncIterable of these chunks. The
 *  order is meaningful: a stream always finishes with exactly one `finish`
 *  chunk (or throws an error before reaching it). */
export type ChatChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-use'; id: string; name: string; args: unknown }
  | { type: 'thinking-delta'; text: string }
  | { type: 'thinking-signature'; signature: string }
  | { type: 'finish'; reason: FinishReason; usage: Usage }

/** Native LLM provider interface — plugins implement this directly. */
export interface LLMProvider extends ProviderUIHints {
  /** Stable identifier stored in the providers table. Plugin loader prefixes
   *  this with `plugin:<plugin-name>:` to avoid collisions with built-ins. */
  readonly type: string
  /** Display name shown in the UI. */
  readonly displayName: string
  /** Declarative schema for the configuration form. */
  readonly configSchema: ProviderConfigSchema

  /** Verify the credentials work. Called by the UI before saving. */
  authenticate(config: ProviderConfig): Promise<AuthResult>

  /** Fetch the current list of models with full metadata. Called on demand
   *  and by the refresh cron. Implementations must not cache across calls
   *  — KinBot's `model-info-cache` is the cache. */
  listModels(config: ProviderConfig): Promise<LLMModel[]>

  /** Stream a chat completion. Implementations own the conversion between
   *  `ChatRequest` and the provider's native format, including all
   *  provider-specific quirks (OAuth headers, message hoisting, thinking
   *  option mapping, etc.). */
  chat(
    model: LLMModel,
    request: ChatRequest,
    config: ProviderConfig,
  ): AsyncIterable<ChatChunk>
}

// ─── Embedding ──────────────────────────────────────────────────────────────

export interface EmbeddingModel {
  id: string
  name: string
  /** Output vector dimension. Optional — some catalogues (Replicate's
   *  community models, etc.) don't expose this; KinBot infers it from
   *  the first embed call when needed. */
  dimensions?: number
  /** Maximum input tokens per single embed call. Optional for the
   *  same reason as `dimensions`. */
  maxInputTokens?: number
  /** Token pricing in USD per million tokens. */
  pricing?: {
    input: number
  }
}

export interface EmbedRequest {
  text: string
  signal?: AbortSignal
}

export interface EmbedResult {
  vector: number[]
  /** Number of tokens consumed. Some providers don't report this — leave
   *  undefined rather than guessing. */
  inputTokens?: number
}

/** Native embedding provider interface — plugins implement this directly. */
export interface EmbeddingProvider extends ProviderUIHints {
  readonly type: string
  readonly displayName: string
  readonly configSchema: ProviderConfigSchema

  authenticate(config: ProviderConfig): Promise<AuthResult>
  listModels(config: ProviderConfig): Promise<EmbeddingModel[]>

  embed(
    model: EmbeddingModel,
    request: EmbedRequest,
    config: ProviderConfig,
  ): Promise<EmbedResult>
}

// ─── Image ──────────────────────────────────────────────────────────────────

export interface ImageModel {
  id: string
  name: string
  /** True when the model accepts a source image as input for editing /
   *  inpainting (vs text-to-image only). */
  supportsImageInput?: boolean
  /** Output sizes the model supports (e.g. ['1024x1024', '1792x1024']).
   *  Used by the UI to constrain the size picker. */
  supportedSizes?: string[]
  /** Pricing per generated image in USD. */
  pricing?: {
    perImage: number
  }
}

export interface ImageRequest {
  prompt: string
  /** Optional source image for editing/inpainting (requires
   *  `model.supportsImageInput`). */
  imageInput?: { data: Uint8Array; mediaType: string }
  /** Target size, e.g. '1024x1024'. When omitted, the provider picks a
   *  sensible default for the model. */
  size?: string
  signal?: AbortSignal
}

export interface ImageResult {
  /** Raw image bytes. */
  data: Uint8Array
  mediaType: string
}

/** Native image provider interface — plugins implement this directly. */
export interface ImageProvider extends ProviderUIHints {
  readonly type: string
  readonly displayName: string
  readonly configSchema: ProviderConfigSchema

  authenticate(config: ProviderConfig): Promise<AuthResult>
  listModels(config: ProviderConfig): Promise<ImageModel[]>

  generate(
    model: ImageModel,
    request: ImageRequest,
    config: ProviderConfig,
  ): Promise<ImageResult>
}

/** Discriminated union of every native provider shape a plugin can declare. */
export type PluginProvider = LLMProvider | EmbeddingProvider | ImageProvider

// ════════════════════════════════════════════════════════════════════════════
//  Hooks
// ════════════════════════════════════════════════════════════════════════════

/**
 * Mapping from each hook name to the exact payload shape KinBot delivers
 * to handlers. Plugin authors get autocomplete on `ctx.<field>` inside their
 * handler — no more loose `[key: string]: unknown` access.
 *
 * When a new hook is added internally, extend this map first and the
 * registry signature picks it up automatically.
 */
export interface HookPayloadMap {
  /** Fired once per Kin turn, just before the system prompt is assembled. */
  beforeChat: {
    kinId: string
    userId?: string
    /** The raw incoming user message content for this turn. */
    message: string
  }
  /** Fired once per Kin turn, after the assistant's response is finalized. */
  afterChat: {
    kinId: string
    userId?: string
    /** The raw incoming user message content for this turn. */
    message: string
    /** The assistant's final text response (excluding tool call payloads). */
    response: string
  }
  /** Fired before each tool call inside a turn. Mutations to `toolArgs` are
   *  observed by the executor when the handler returns the modified ctx. */
  beforeToolCall: {
    kinId: string
    userId?: string
    taskId?: string
    isSubKin: boolean
    /** Tool name as seen by the LLM (already plugin-prefixed when applicable). */
    toolName: string
    /** The arguments passed to the tool by the LLM. */
    toolArgs: unknown
    /** Originating channel queue item ID (causal chain tracking). */
    channelOriginId?: string
    cronId?: string
    ticketId?: string
  }
  /** Fired after each tool call. `toolResult` is whatever the tool returned. */
  afterToolCall: {
    kinId: string
    userId?: string
    taskId?: string
    isSubKin: boolean
    toolName: string
    toolArgs: unknown
    toolResult: unknown
    channelOriginId?: string
    cronId?: string
    ticketId?: string
  }
}

export type HookName = keyof HookPayloadMap

/**
 * A hook handler receives a strongly-typed payload based on its name and may
 * optionally return a modified payload to be used by downstream consumers.
 * Most handlers return `void` (observe-only).
 */
export type HookHandler<H extends HookName = HookName> = (
  context: HookPayloadMap[H],
) =>
  | Promise<HookPayloadMap[H] | void>
  | HookPayloadMap[H]
  | void

// ════════════════════════════════════════════════════════════════════════════
//  Plugin context (what the host passes to the default export)
// ════════════════════════════════════════════════════════════════════════════

export interface PluginLogger {
  debug(msg: string): void
  debug(obj: Record<string, unknown>, msg: string): void
  info(msg: string): void
  info(obj: Record<string, unknown>, msg: string): void
  warn(msg: string): void
  warn(obj: Record<string, unknown>, msg: string): void
  error(msg: string): void
  error(obj: Record<string, unknown>, msg: string): void
}

export interface PluginStorageAPI {
  get<T = unknown>(key: string): Promise<T | null>
  set<T = unknown>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  list(prefix?: string): Promise<string[]>
  clear(): Promise<void>
}

export interface PluginHTTPClient {
  fetch(url: string, init?: RequestInit): Promise<Response>
}

/**
 * Vault access exposed to plugins.
 *
 * Read access is permissive: `getSecret(key)` reads any vault entry by key.
 * Plugins are expected to only read keys they were handed via their config
 * (e.g. a channel password field stored by KinBot under a deterministic key).
 * There is no API to enumerate the full vault.
 *
 * Write access is strictly scoped: `setSecret` / `deleteSecret` / `listKeys`
 * operate inside a `plugin:<plugin-name>:` namespace so plugins cannot
 * overwrite each other's secrets or those managed by KinBot core.
 */
export interface PluginVaultAPI {
  /** Read any vault entry by its key (returns the decrypted value or null).
   *  Permissive — the plugin must know the key (typically passed via config). */
  getSecret(key: string): Promise<string | null>
  /** Store a secret under `plugin:<plugin-name>:<key>`. Auto-scoped. */
  setSecret(key: string, value: string, description?: string): Promise<void>
  /** Delete a secret stored by this plugin. No-op when the key doesn't exist. */
  deleteSecret(key: string): Promise<void>
  /** List the keys owned by this plugin (unprefixed). */
  listKeys(): Promise<string[]>
}

export interface PluginManifestInfo {
  name: string
  version: string
}

// ─── Card primitives (strict discriminated union) ────────────────────────────

/** Color/intent variant accepted by most card primitives. */
export type PluginCardVariant =
  | 'default'
  | 'success'
  | 'warning'
  | 'destructive'
  | 'primary'
  | 'muted'

/** Animation applied to a status-banner. */
export type PluginCardBannerAnimation = 'pulse' | 'shimmer' | 'spin' | 'none'

/** A single input slot attached to a card action button. */
export interface PluginCardActionInput {
  type: 'text' | 'textarea'
  placeholder?: string
}

export interface PluginCardAction {
  id: string
  label: string
  variant?: PluginCardVariant
  input?: PluginCardActionInput
  /** If true, the UI confirms with the user before firing the action. */
  confirm?: boolean
}

export interface PluginCardInfoGridItem {
  label: string
  value: string
  variant?: PluginCardVariant
  /** When true, long values are clipped with ellipsis and a tooltip shows
   *  the full text. */
  truncate?: boolean
  /** Icon next to the value. Either a Lucide icon name (`"Sparkles"`) or a
   *  react-icons identifier in the form `"<collection>/<ComponentName>"`
   *  (`"bs/BsClaude"`, `"si/SiOpenai"`). */
  icon?: string
}

/** Discriminated union of every primitive a plugin can put in a card layout.
 *
 *  Plugins build these objects directly or via the `card.*` helpers below.
 *  String fields may contain `{{key}}` placeholders interpolated against
 *  the card's state at render time.
 */
export type PluginCardPrimitive =
  | {
      type: 'header'
      title: string
      icon?: string
      accent?: PluginCardVariant
    }
  | {
      type: 'info-grid'
      columns?: 2 | 3
      items: PluginCardInfoGridItem[]
    }
  | {
      type: 'status-banner'
      label: string
      sublabel?: string
      variant?: PluginCardVariant
      icon?: string
      animated?: PluginCardBannerAnimation
    }
  | {
      type: 'progress'
      value?: number
      max?: number
      indeterminate?: boolean
      label?: string
    }
  | {
      type: 'collapsible'
      label: string
      defaultOpen?: boolean
      content: PluginCardPrimitive | PluginCardPrimitive[]
    }
  | {
      type: 'log-stream'
      lines: string[]
      autoscroll?: boolean
      maxHeight?: number
    }
  | { type: 'action-row'; actions: PluginCardAction[] }
  | { type: 'markdown'; content: string }
  | { type: 'spinner'; label?: string }
  | {
      type: 'badge'
      text: string
      variant?: PluginCardVariant
      icon?: string
    }
  | { type: 'divider'; label?: string }

/**
 * Builder helpers for card primitives. Plugins can either hand-write the
 * discriminated union literals or use these helpers for slightly more
 * ergonomic call sites with default-friendly argument shapes.
 *
 *   import { card, z } from '@kinbot-developer/sdk'
 *
 *   ctx.cards.emit({
 *     kinId,
 *     cardType: 'task-run',
 *     layout: [
 *       card.header({ title: 'Task running…', icon: 'Sparkles' }),
 *       card.progress({ indeterminate: true }),
 *       card.actionRow([{ id: 'cancel', label: 'Cancel', variant: 'destructive' }]),
 *     ],
 *     initialState: {},
 *   })
 */
export const card = {
  header(params: {
    title: string
    icon?: string
    accent?: PluginCardVariant
  }): Extract<PluginCardPrimitive, { type: 'header' }> {
    return { type: 'header', ...params }
  },
  infoGrid(params: {
    items: PluginCardInfoGridItem[]
    columns?: 2 | 3
  }): Extract<PluginCardPrimitive, { type: 'info-grid' }> {
    return { type: 'info-grid', ...params }
  },
  statusBanner(params: {
    label: string
    sublabel?: string
    variant?: PluginCardVariant
    icon?: string
    animated?: PluginCardBannerAnimation
  }): Extract<PluginCardPrimitive, { type: 'status-banner' }> {
    return { type: 'status-banner', ...params }
  },
  progress(
    params: {
      value?: number
      max?: number
      indeterminate?: boolean
      label?: string
    } = {},
  ): Extract<PluginCardPrimitive, { type: 'progress' }> {
    return { type: 'progress', ...params }
  },
  collapsible(params: {
    label: string
    defaultOpen?: boolean
    content: PluginCardPrimitive | PluginCardPrimitive[]
  }): Extract<PluginCardPrimitive, { type: 'collapsible' }> {
    return { type: 'collapsible', ...params }
  },
  logStream(params: {
    lines: string[]
    autoscroll?: boolean
    maxHeight?: number
  }): Extract<PluginCardPrimitive, { type: 'log-stream' }> {
    return { type: 'log-stream', ...params }
  },
  actionRow(
    actions: PluginCardAction[],
  ): Extract<PluginCardPrimitive, { type: 'action-row' }> {
    return { type: 'action-row', actions }
  },
  markdown(
    content: string,
  ): Extract<PluginCardPrimitive, { type: 'markdown' }> {
    return { type: 'markdown', content }
  },
  spinner(
    label?: string,
  ): Extract<PluginCardPrimitive, { type: 'spinner' }> {
    return label === undefined ? { type: 'spinner' } : { type: 'spinner', label }
  },
  badge(params: {
    text: string
    variant?: PluginCardVariant
    icon?: string
  }): Extract<PluginCardPrimitive, { type: 'badge' }> {
    return { type: 'badge', ...params }
  },
  divider(
    label?: string,
  ): Extract<PluginCardPrimitive, { type: 'divider' }> {
    return label === undefined ? { type: 'divider' } : { type: 'divider', label }
  },
} as const

/** Card APIs exposed to plugins. The plugin name is captured at context
 *  creation time so plugins cannot accidentally emit cards under another
 *  plugin's identity.
 *
 *  `layout` is typed as the strict `PluginCardPrimitive[]` discriminated
 *  union: plugin authors get autocomplete on every primitive, and a typo
 *  in a `type` field fails at compile time. */
export interface PluginCardsAPI {
  emit(params: {
    kinId: string
    cardType: string
    layout: PluginCardPrimitive[]
    initialState: Record<string, unknown>
  }): Promise<{ messageId: string; cardInstanceId: string }>
  update(params: {
    cardInstanceId: string
    state: Record<string, unknown>
  }): Promise<void>
}

/** Payload delivered to a plugin when a user clicks an action on its card. */
export interface PluginCardActionContext {
  cardInstanceId: string
  actionId: string
  input?: string
  kinId: string
}

export type PluginCardActionResult = { ok: true } | { ok: false; error: string }

/**
 * The runtime context KinBot passes to every plugin's default export.
 *
 * The `Config` generic lets a plugin author declare the exact shape of
 * their config so `ctx.config.<field>` is strongly typed:
 *
 *   import type { PluginContext } from '@kinbot-developer/sdk'
 *
 *   interface MyConfig { apiKey: string; region?: 'eu' | 'us' }
 *
 *   export default function (ctx: PluginContext<MyConfig>) {
 *     const region = ctx.config.region ?? 'eu'   // typed
 *     // ctx.config.apiKey  ← string
 *   }
 *
 * Plugins that don't care fall back to the default
 * `Record<string, unknown>` and read fields with their own narrowing.
 *
 * The runtime never validates the config against the generic — KinBot
 * already validated it against the manifest's declared config schema
 * before instantiating the context. The generic is purely a type-side
 * convenience for the plugin's call sites.
 */
export interface PluginContext<Config = Record<string, unknown>> {
  config: Config
  log: PluginLogger
  storage: PluginStorageAPI
  http: PluginHTTPClient
  vault: PluginVaultAPI
  manifest: PluginManifestInfo
  cards: PluginCardsAPI
}

/**
 * The object a plugin's default-exported function must return. Every field
 * is optional — plugins typically declare one or two of them.
 */
export interface PluginExports {
  tools?: Record<string, ToolRegistration>
  /**
   * Native AI providers contributed by the plugin. KinBot's plugin loader
   * inspects each provider's shape (the `chat` / `embed` / `generate`
   * method) and registers it into the matching native registry. The same
   * `LLMProvider` / `EmbeddingProvider` / `ImageProvider` interfaces back
   * the built-in providers — there is no second shape for plugins.
   *
   *   providers: [
   *     new MyMistralProvider(),    // LLMProvider
   *     new MyVoyageEmbedder(),     // EmbeddingProvider
   *   ]
   */
  providers?: PluginProvider[]
  channels?: Record<string, ChannelAdapter>
  /** Hook handlers keyed by hook name. Each handler receives the typed
   *  payload for its hook (see {@link HookPayloadMap}). */
  hooks?: { [H in HookName]?: HookHandler<H> }
  /** Handle user clicks on action-row buttons emitted by this plugin's cards. */
  onCardAction?(ctx: PluginCardActionContext): Promise<PluginCardActionResult>
  activate?(): Promise<void>
  deactivate?(): Promise<void>
}
