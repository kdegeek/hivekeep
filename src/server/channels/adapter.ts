import { existsSync } from 'fs'

// ─── Adapter metadata ──────────────────────────────────────────────────────

export interface ChannelAdapterMeta {
  displayName: string
  brandColor?: string
  iconUrl?: string
}

// ─── Adapter configuration schema ───────────────────────────────────────────

// Declared in `src/shared/types.ts` so the client and server agree on the
// shape used by the dynamic form and the server-side Zod validator.
import type { ChannelConfigField, ChannelConfigSchema } from '@/shared/types'
export type { ChannelConfigField, ChannelConfigSchema }

// ─── Incoming attachments from an external platform ─────────────────────────

export interface IncomingAttachment {
  /** Platform-specific file identifier (e.g. Telegram file_id, Discord CDN URL) */
  platformFileId: string
  /** MIME type if known (e.g. 'image/jpeg', 'application/pdf') */
  mimeType?: string
  /** Original file name if available */
  fileName?: string
  /** File size in bytes if known */
  fileSize?: number
  /** Direct download URL if available (Discord CDN, Slack URL, etc.) */
  url?: string
  /** Optional headers required for downloading (e.g. WhatsApp auth) */
  headers?: Record<string, string>
}

// ─── Incoming message from an external platform ─────────────────────────────

export interface IncomingMessage {
  platformUserId: string
  platformUsername?: string
  platformDisplayName?: string
  platformMessageId: string
  platformChatId: string
  content: string
  /** File attachments (images, documents, audio, video) from the platform */
  attachments?: IncomingAttachment[]
  /**
   * Free-form structured context provided by the channel adapter.
   * Persisted into the user message metadata under the `channel` key, and
   * injected into the LLM prompt as a `<channel-context>` block so the Kin
   * can use it for routing decisions (modality, presence, channel type, etc.)
   * without polluting the visible content.
   *
   * Examples:
   *   - `{ modality: 'voice', channel: { id: 12, name: 'Gaming' }, present: ['Alice','Bob'] }`
   *   - `{ chatType: 'private' }`
   *
   * Non-breaking: built-in adapters can ignore this field.
   */
  metadata?: Record<string, unknown>
}

export type IncomingMessageHandler = (message: IncomingMessage) => Promise<void>

// ─── Outbound attachment (file to send) ─────────────────────────────────────

export interface OutboundAttachment {
  /** Local file path (absolute) or a public URL */
  source: string
  /** MIME type (e.g. 'image/png', 'application/pdf') */
  mimeType: string
  /** Display file name (optional, derived from source if omitted) */
  fileName?: string
}

// ─── Outbound message params ────────────────────────────────────────────────

export interface OutboundMessageParams {
  chatId: string
  content: string
  replyToMessageId?: string
  /** Optional file attachments to send with the message */
  attachments?: OutboundAttachment[]
  /**
   * Locale of the Kin owner ('en', 'fr', …). Adapters may use it to localize
   * the `contextLine` they return in the result. Optional for back-compat.
   */
  locale?: string
}

// ─── Outbound message result ────────────────────────────────────────────────

export interface OutboundMessageResult {
  platformMessageId: string
  /**
   * Optional human-readable, already-translated context describing the
   * transport: TTS mode, voice, target channel, etc. Persisted on the kin
   * message metadata and rendered as a subtle hint below the bubble.
   * Adapters that don't produce one keep current behavior (nothing shown).
   */
  contextLine?: string
  /**
   * Optional raw structured info (mode, voice, channel name…) kept alongside
   * `contextLine` for debug/audit. Not rendered directly.
   */
  deliveryMeta?: Record<string, unknown>
}

// ─── Platform adapter interface ─────────────────────────────────────────────

export interface ChannelAdapter {
  /** Unique platform identifier */
  readonly platform: string

  /** Optional metadata for display purposes (name, color, icon) */
  readonly meta?: ChannelAdapterMeta

  /**
   * Optional declarative configuration schema. When provided, the UI renders
   * a dynamic form from `fields` and the server validates `platformConfig`
   * against a Zod schema derived from it. Adapters that don't declare one
   * keep the legacy behavior (bot-token-only form) for now — migration will
   * happen adapter by adapter.
   */
  readonly configSchema?: ChannelConfigSchema

  /**
   * Start receiving messages. Called when a channel becomes active.
   * The adapter should call `onMessage` when messages arrive.
   */
  start(
    channelId: string,
    config: Record<string, unknown>,
    onMessage: IncomingMessageHandler,
  ): Promise<void>

  /**
   * Stop receiving messages. Called when channel is deactivated or deleted.
   */
  stop(channelId: string): Promise<void>

  /**
   * Send a message to the platform.
   * Returns the platform's message ID for linking, plus an optional
   * `contextLine` describing how the message was transported (TTS vs text,
   * voice used, target channel, etc.) for display in the conversation UI.
   */
  sendMessage(
    channelId: string,
    config: Record<string, unknown>,
    params: OutboundMessageParams,
  ): Promise<OutboundMessageResult>

  /**
   * Optional: turn the structured `metadata` produced for an inbound message
   * into a short, already-localized line of context for the conversation UI
   * (e.g. "Sent by Alice from #Gaming via voice (with Bob, Charlie)").
   * The core passes the Kin owner's locale; adapters that don't implement
   * this method simply won't surface a context line.
   */
  formatInboundContext?(
    metadata: Record<string, unknown>,
    locale: string,
  ): string | null

  /**
   * Declares how this adapter handles identity switching when a channel is
   * transferred from one Kin to another (transfer_channel tool):
   *
   *   - 'native': the adapter implements onIdentityChange and pushes the
   *     new Kin's display name (and avatar when supported) to the external
   *     platform. The core does NOT prefix outbound messages.
   *   - 'prefix': the adapter cannot switch identity natively. The core
   *     prepends "[Kin Name] " to every outbound text message so the user
   *     always knows which Kin is speaking after a handoff.
   *   - 'none': neither identity change nor prefix. Use only when neither
   *     makes sense (rare).
   *
   * Default when undefined: 'prefix' (safest, always informs the user).
   *
   * Precedence: 'native' takes priority (real identity switch beats a
   * textual hint); 'prefix' is the fallback default; 'none' disables both.
   */
  readonly identitySwitchMode?: 'native' | 'prefix' | 'none'

  /**
   * Optional. Called when the channel binding is transferred to a different
   * Kin. The adapter should update the bot's display name and avatar on
   * the external platform.
   *
   * Adapters that cannot switch identity natively should NOT implement
   * this method, and should set identitySwitchMode to 'prefix' or 'none'.
   *
   * Errors thrown here are caught and logged at warn level by the caller;
   * they do not block the transfer (the binding is already mutated by the
   * time onIdentityChange runs, and the prefix fallback already covers
   * the user-visible side when native fails).
   */
  onIdentityChange?(
    channelId: string,
    config: Record<string, unknown>,
    newIdentity: {
      kinSlug: string
      kinName: string
      avatarUrl?: string
    },
  ): Promise<void>

  /**
   * Validate the configuration (e.g., test bot token).
   */
  validateConfig(config: Record<string, unknown>): Promise<{ valid: boolean; error?: string }>

  /**
   * Get information about the bot (name, username) for display.
   */
  getBotInfo(config: Record<string, unknown>): Promise<{ name: string; username?: string } | null>

  /**
   * Send a typing indicator to the platform (optional).
   * Platforms that don't support it can leave this unimplemented.
   */
  sendTypingIndicator?(channelId: string, config: Record<string, unknown>, chatId: string): Promise<void>

  /**
   * Optional. Handle an inbound HTTP webhook from the external platform.
   * Called by the built-in dispatcher route
   * POST /api/channels/plugin/:platform/webhook/:channelId.
   *
   * The adapter is responsible for parsing the request, validating its
   * authenticity (signature, etc.), and returning either an IncomingMessage
   * to inject into the Kin queue, or null to ignore the event, along with
   * the HTTP Response to send back to the platform.
   *
   * Adapters that use a long-lived connection (Telegram polling, Discord
   * WebSocket, Matrix sync) do not need this. Adapters that are webhook
   * driven (Twilio, future SMS or voice providers) implement it.
   *
   * Distinct from any platform-specific `handleWebhook` helper an adapter
   * may carry internally (e.g. Signal's post-parsing helper). This one is
   * the transport-level entry point: raw Request in, raw Response out.
   */
  handleInboundWebhook?(
    channelId: string,
    config: Record<string, unknown>,
    req: Request,
  ): Promise<{ incoming: IncomingMessage | null; response: Response }>
}

// ─── Outbound attachment helpers ────────────────────────────────────────────

/**
 * Read an OutboundAttachment into a Blob suitable for multipart uploads.
 * Supports local file paths and HTTP(S) URLs.
 */
export async function readAttachmentBlob(att: OutboundAttachment): Promise<Blob> {
  if (att.source.startsWith('http://') || att.source.startsWith('https://')) {
    const resp = await fetch(att.source)
    if (!resp.ok) throw new Error(`Failed to fetch attachment URL: ${resp.status}`)
    return await resp.blob()
  }
  // Local file
  if (!existsSync(att.source)) throw new Error(`Attachment file not found: ${att.source}`)
  const file = Bun.file(att.source)
  return file
}

/**
 * Derive a file name for an outbound attachment.
 */
export function attachmentFileName(att: OutboundAttachment): string {
  if (att.fileName) return att.fileName
  // Try to extract from source path/URL
  const lastSegment = att.source.split('/').pop()?.split('?')[0]
  if (lastSegment && lastSegment.includes('.')) return lastSegment
  // Fallback based on mime type
  const ext = att.mimeType.split('/')[1]?.split('+')[0] ?? 'bin'
  return `file.${ext}`
}

/**
 * Check if an attachment is an image type.
 */
export function isImageAttachment(att: OutboundAttachment): boolean {
  return att.mimeType.startsWith('image/')
}
