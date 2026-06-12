import { eq, and, desc, count } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import { messages, channels, channelUserMappings, channelMessageLinks, contactPlatformIds, contactNicknames, agents, contacts, userProfiles } from '@/server/db/schema'
import { enqueueMessage } from '@/server/services/queue'
import { downloadChannelAttachments } from '@/server/services/files'
import { createSecret, deleteSecret, getSecretValue, getSecretByKey } from '@/server/services/vault'
import { createContact } from '@/server/services/contacts'
import { channelAdapters } from '@/server/channels/index'
import { sseManager } from '@/server/sse/index'
import { config } from '@/server/config'
import { agentAvatarUrl } from '@/server/services/field-validator'
import { getContactDisplayName } from '@/shared/contact-display'
import { applyAgentNamePrefix } from '@/server/services/channel-prefix'
import type { IncomingMessage, OutboundAttachment, DeliveryStatusUpdate } from '@/server/channels/adapter'
import type { ChannelPlatform, ChannelStatus } from '@/shared/types'

const log = createLogger('channels')

// ─── In-memory sideband for channel metadata (same pattern as queueFileIds) ──

export interface ChannelQueueMeta {
  channelId: string
  platformChatId: string
  platformMessageId: string
  platformUserId: string
}

const channelQueueMeta = new Map<string, ChannelQueueMeta>()

export function setChannelQueueMeta(queueItemId: string, meta: ChannelQueueMeta) {
  channelQueueMeta.set(queueItemId, meta)
}

export function getChannelQueueMeta(queueItemId: string): ChannelQueueMeta | undefined {
  return channelQueueMeta.get(queueItemId)
}

export function popChannelQueueMeta(queueItemId: string): ChannelQueueMeta | undefined {
  const meta = channelQueueMeta.get(queueItemId)
  if (meta) channelQueueMeta.delete(queueItemId)
  return meta
}

// ─── Channel transfer hints (one-shot, consumed by the next inbound) ────────
//
// When an Agent calls transfer_channel(channelId, targetAgentSlug, reason?), the
// channel binding mutates (channels.agentId is updated). The next inbound on
// the channel should carry transfer context so the new Agent understands it
// just inherited the conversation. We stash the hint here keyed by channelId.
// The hint is popped (consumed) by handleIncomingChannelMessage when the
// next inbound arrives, and merged into the user message metadata under
// `channelTransfer`. The agent-engine then surfaces it in <channel-context>.
//
// In-memory only, lost on restart. Acceptable trade-off: a stale hint after
// a restart is harmless (the Agent will simply miss the one-shot transfer
// note; the conversation history and the audit-trail system messages
// remain).

export interface ChannelTransferHint {
  fromAgentId: string
  fromAgentSlug: string
  fromAgentName: string
  reason?: string
  at: number
}

const channelTransferHints = new Map<string, ChannelTransferHint>()

export function setChannelTransferHint(channelId: string, hint: ChannelTransferHint): void {
  channelTransferHints.set(channelId, hint)
}

export function popChannelTransferHint(channelId: string): ChannelTransferHint | undefined {
  const hint = channelTransferHints.get(channelId)
  if (hint) channelTransferHints.delete(channelId)
  return hint
}

// ─── Channel origin store (causal chain tracking for follow-up delivery) ─────

export interface ChannelOriginMeta {
  channelId: string
  platformChatId: string
  platformMessageId: string
  platformUserId: string
  createdAt: number
  ttlMs: number
}

const channelOriginStore = new Map<string, ChannelOriginMeta>()

export function setChannelOriginMeta(originId: string, meta: ChannelOriginMeta): void {
  channelOriginStore.set(originId, meta)
}

export function getChannelOriginMeta(originId: string): ChannelOriginMeta | undefined {
  const meta = channelOriginStore.get(originId)
  if (!meta) return undefined
  if (Date.now() - meta.createdAt > meta.ttlMs) {
    channelOriginStore.delete(originId)
    return undefined
  }
  return meta
}

// ─── Locale resolution (channel → agent → owner → user_profiles.language) ─────

const DEFAULT_LOCALE = 'en'

/**
 * Resolve the locale to use when an adapter localizes a `contextLine` for a
 * channel. The owner of the Agent attached to the channel sees the chat UI, so
 * we pick that user's `user_profiles.language`. Falls back to 'en'.
 */
export function resolveChannelLocale(channelId: string): string {
  try {
    const row = db
      .select({ language: userProfiles.language })
      .from(channels)
      .innerJoin(agents, eq(channels.agentId, agents.id))
      .innerJoin(userProfiles, eq(agents.createdBy, userProfiles.userId))
      .where(eq(channels.id, channelId))
      .get()
    return row?.language ?? DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

interface CreateChannelParams {
  agentId: string
  name: string
  platform: ChannelPlatform
  /**
   * Raw configuration values keyed by the field names declared in the
   * adapter's configSchema (e.g. `{ botToken: 'xxx', allowedChatIds: [...] }`).
   * Password fields are auto-vaulted before persistence and replaced with
   * `<name>VaultKey` references in the stored `platformConfig` JSON.
   */
  platformConfig?: Record<string, unknown>
  allowedChatIds?: string[]
  autoCreateContacts?: boolean
  createdBy?: 'user' | 'agent'
}

export async function createChannel(params: CreateChannelParams) {
  // Check max per Agent limit
  const existing = await db
    .select()
    .from(channels)
    .where(eq(channels.agentId, params.agentId))
    .all()

  if (existing.length >= config.channels.maxPerAgent) {
    throw new Error(`Max channels per Agent (${config.channels.maxPerAgent}) reached`)
  }

  const adapter = channelAdapters.get(params.platform)

  const id = uuid()
  const now = new Date()
  const input = params.platformConfig ?? {}

  // Build stored platformConfig from the adapter's schema. Password fields
  // are vaulted and replaced with `<name>VaultKey`; other declared fields
  // are stored as-is. Undeclared keys in `input` are dropped silently
  // (the route already Zod-validates against the schema before calling).
  // Naming convention for new vault keys: `channel_<platform>_<id>_<field>`.
  // Pre-existing channels created before issue #381 used the older single-key
  // format `channel_<platform>_<id>` (for botToken only); those entries
  // remain valid because their `botTokenVaultKey` value in DB still points
  // to that exact secret — the adapter just reads whatever VaultKey is in
  // the stored config.
  const stored: Record<string, unknown> = {}
  for (const field of adapter?.configSchema?.fields ?? []) {
    const value = input[field.name]
    if (value === undefined || value === null || value === '') continue
    if (field.type === 'password') {
      const vaultKey = `channel_${params.platform}_${id}_${field.name}`
      await createSecret(
        vaultKey,
        String(value),
        undefined,
        `${field.label} for ${params.platform} channel "${params.name}"`,
      )
      stored[`${field.name}VaultKey`] = vaultKey
    } else {
      stored[field.name] = value
    }
  }
  if (params.allowedChatIds?.length) {
    stored.allowedChatIds = params.allowedChatIds
  }

  await db.insert(channels).values({
    id,
    agentId: params.agentId,
    name: params.name,
    platform: params.platform,
    platformConfig: JSON.stringify(stored),
    status: 'inactive',
    autoCreateContacts: params.autoCreateContacts ?? true,
    messagesReceived: 0,
    messagesSent: 0,
    createdBy: params.createdBy ?? 'user',
    createdAt: now,
    updatedAt: now,
  })

  const created = await db.select().from(channels).where(eq(channels.id, id)).get()

  if (created) {
    sseManager.broadcast({
      type: 'channel:created',
      agentId: created.agentId,
      data: { channelId: created.id, agentId: created.agentId, platform: created.platform },
    })
  }

  log.info({ channelId: id, agentId: params.agentId, platform: params.platform, name: params.name }, 'Channel created')
  return created!
}

export async function getChannel(channelId: string) {
  return db.select().from(channels).where(eq(channels.id, channelId)).get()
}

export async function listChannels(agentId?: string) {
  if (agentId) {
    return db.select().from(channels).where(eq(channels.agentId, agentId)).all()
  }
  return db.select().from(channels).all()
}

/**
 * List every channel on the platform, joined with its owner Agent's slug/name.
 * Powers `list_channels({ scope: 'all' })` so an Agent can discover channels it can
 * borrow for a cross-Agent send. Left-join on agents keeps a row even if the owner
 * Agent was deleted (slug/name then null).
 */
export async function listChannelsWithOwners() {
  return db
    .select({
      id: channels.id,
      agentId: channels.agentId,
      name: channels.name,
      platform: channels.platform,
      status: channels.status,
      messagesReceived: channels.messagesReceived,
      messagesSent: channels.messagesSent,
      lastActivityAt: channels.lastActivityAt,
      ownerAgentSlug: agents.slug,
      ownerAgentName: agents.name,
    })
    .from(channels)
    .leftJoin(agents, eq(channels.agentId, agents.id))
    .all()
}

export async function updateChannel(
  channelId: string,
  updates: Partial<{
    name: string
    agentId: string
    allowedChatIds: string[] | null
    autoCreateContacts: boolean
  }>,
) {
  const existing = await getChannel(channelId)
  if (!existing) return null

  const setValues: Record<string, unknown> = { updatedAt: new Date() }
  if (updates.name !== undefined) setValues.name = updates.name
  if (updates.agentId !== undefined) setValues.agentId = updates.agentId
  if (updates.autoCreateContacts !== undefined) setValues.autoCreateContacts = updates.autoCreateContacts

  // Update allowedChatIds in platform config
  if (updates.allowedChatIds !== undefined) {
    const cfg = JSON.parse(existing.platformConfig) as Record<string, unknown>
    if (updates.allowedChatIds === null || updates.allowedChatIds.length === 0) {
      delete cfg.allowedChatIds
    } else {
      cfg.allowedChatIds = updates.allowedChatIds
    }
    setValues.platformConfig = JSON.stringify(cfg)
  }

  await db.update(channels).set(setValues).where(eq(channels.id, channelId))
  const updated = await getChannel(channelId)

  if (updated) {
    sseManager.broadcast({
      type: 'channel:updated',
      agentId: updated.agentId,
      data: { channelId: updated.id, agentId: updated.agentId },
    })
  }

  return updated
}

export async function deleteChannel(channelId: string) {
  const existing = await getChannel(channelId)
  if (!existing) return false

  // Stop adapter if active
  if (existing.status === 'active') {
    const adapter = channelAdapters.get(existing.platform)
    if (adapter) {
      try {
        const cfg = JSON.parse(existing.platformConfig) as Record<string, unknown>
        await adapter.stop(channelId)
      } catch (err) {
        log.warn({ channelId, err }, 'Failed to stop adapter during delete')
      }
    }
  }

  // Delete every vault secret referenced by the stored platformConfig.
  // Any key ending in `VaultKey` is treated as a vault reference (the
  // generalized vault dance writes `<name>VaultKey` for each password
  // field in the adapter's configSchema). Pre-#381 channels stored only
  // `botTokenVaultKey`; this still cleans them up.
  const storedConfig = JSON.parse(existing.platformConfig) as Record<string, unknown>
  for (const [key, value] of Object.entries(storedConfig)) {
    if (typeof value !== 'string' || !key.endsWith('VaultKey')) continue
    try {
      const secret = await getSecretByKey(value)
      if (secret) await deleteSecret(secret.id)
    } catch (err) {
      log.warn({ channelId, key, err }, 'Failed to delete vault secret during channel delete')
    }
  }

  await db.delete(channels).where(eq(channels.id, channelId))

  sseManager.broadcast({
    type: 'channel:deleted',
    agentId: existing.agentId,
    data: { channelId, agentId: existing.agentId },
  })

  log.info({ channelId, agentId: existing.agentId }, 'Channel deleted')
  return true
}

// ─── Activate / Deactivate ──────────────────────────────────────────────────

export async function activateChannel(channelId: string) {
  const channel = await getChannel(channelId)
  if (!channel) return null

  const adapter = channelAdapters.get(channel.platform)
  if (!adapter) {
    await setChannelStatus(channelId, 'error', `No adapter for platform "${channel.platform}"`)
    return null
  }

  const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>

  try {
    await adapter.start(channelId, cfg, (incoming) => handleIncomingChannelMessage(channelId, incoming))
    await setChannelStatus(channelId, 'active')
    log.info({ channelId, platform: channel.platform }, 'Channel activated')
    return await getChannel(channelId)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error'
    await setChannelStatus(channelId, 'error', errMsg)
    log.error({ channelId, err: errMsg }, 'Failed to activate channel')
    return await getChannel(channelId)
  }
}

export async function deactivateChannel(channelId: string) {
  const channel = await getChannel(channelId)
  if (!channel) return null

  const adapter = channelAdapters.get(channel.platform)
  if (adapter) {
    try {
      const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
      await adapter.stop(channelId)
    } catch (err) {
      log.warn({ channelId, err }, 'Failed to stop adapter during deactivate')
    }
  }

  await setChannelStatus(channelId, 'inactive')
  log.info({ channelId }, 'Channel deactivated')
  return await getChannel(channelId)
}

async function setChannelStatus(channelId: string, status: ChannelStatus, statusMessage?: string) {
  await db
    .update(channels)
    .set({ status, statusMessage: statusMessage ?? null, updatedAt: new Date() })
    .where(eq(channels.id, channelId))

  const updated = await getChannel(channelId)
  if (updated) {
    sseManager.broadcast({
      type: 'channel:updated',
      agentId: updated.agentId,
      data: { channelId, agentId: updated.agentId, status },
    })
  }
}

// ─── Test connection ────────────────────────────────────────────────────────

export async function testChannel(channelId: string): Promise<{ valid: boolean; error?: string; botInfo?: { name: string; username?: string } }> {
  const channel = await getChannel(channelId)
  if (!channel) return { valid: false, error: 'Channel not found' }

  const adapter = channelAdapters.get(channel.platform)
  if (!adapter) return { valid: false, error: `No adapter for platform "${channel.platform}"` }

  const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
  const result = await adapter.validateConfig(cfg)

  if (result.valid) {
    const botInfo = await adapter.getBotInfo(cfg)
    return { valid: true, botInfo: botInfo ?? undefined }
  }

  return result
}

// ─── Incoming message handling ──────────────────────────────────────────────

export async function handleIncomingChannelMessage(channelId: string, incoming: IncomingMessage) {
  const channel = await getChannel(channelId)
  if (!channel || channel.status !== 'active') return

  const cfg = JSON.parse(channel.platformConfig) as { allowedChatIds?: string[] }

  // Check if chat is allowed
  if (cfg.allowedChatIds?.length && !cfg.allowedChatIds.includes(incoming.platformChatId)) {
    log.debug({ channelId, chatId: incoming.platformChatId }, 'Chat not in allowedChatIds, ignoring')
    return
  }

  // Resolve contact via contactPlatformIds or create pending mapping
  const { contact, pendingMappingId } = await resolveChannelContact(channel, incoming)
  let contactDisplayName: string | null = null
  if (contact) {
    // If firstName/lastName both missing, look up the first nickname as fallback
    let firstNickname: string | undefined
    if (!contact.firstName && !contact.lastName) {
      const nick = db
        .select({ nickname: contactNicknames.nickname })
        .from(contactNicknames)
        .where(eq(contactNicknames.contactId, contact.id))
        .limit(1)
        .get()
      firstNickname = nick?.nickname
    }
    const name = getContactDisplayName({
      firstName: contact.firstName,
      lastName: contact.lastName,
      nicknames: firstNickname ? [firstNickname] : undefined,
    })
    contactDisplayName = name === 'Unnamed contact' ? null : name
  }
  const senderName = contactDisplayName ?? incoming.platformDisplayName ?? incoming.platformUsername ?? 'Unknown'

  // ─── Approval gate ────────────────────────────────────────────────────────
  if (pendingMappingId) {
    const adapter = channelAdapters.get(channel.platform)
    if (adapter) {
      const adapterCfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
      adapter.sendMessage(channel.id, adapterCfg, {
        chatId: incoming.platformChatId,
        content: 'Your access is pending approval. Please wait for an admin to approve your access.',
        replyToMessageId: incoming.platformMessageId,
      }).catch((err) => log.warn({ channelId, err }, 'Failed to send pending-approval message'))
    }

    // Update stats but do NOT enqueue
    await db
      .update(channels)
      .set({
        messagesReceived: channel.messagesReceived + 1,
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(channels.id, channelId))
    return
  }
  // ─── End approval gate ────────────────────────────────────────────────────

  // Handle bot commands (/start, /start@botname, /start deeplink)
  if (/^\/start(?:\s|@|$)/.test(incoming.content)) {
    await handleBotStart(channel, incoming, senderName)
    return
  }

  // Format content with sender context
  // When the contact is not resolved, include platform metadata so the Agent can identify/create the contact
  let content: string
  if (contact) {
    content = `[${channel.platform}:${senderName}] ${incoming.content}`
  } else {
    const parts = [`${channel.platform}_id: ${incoming.platformUserId}`]
    if (incoming.platformUsername) parts.push(`username: ${incoming.platformUsername}`)
    content = `[${channel.platform}:${senderName} (unknown — ${parts.join(', ')})] ${incoming.content}`
  }

  // Download and store any file attachments
  let fileIds: string[] | undefined
  if (incoming.attachments && incoming.attachments.length > 0) {
    const result = await downloadChannelAttachments(channel.agentId, incoming.attachments)
    fileIds = result.fileIds.length > 0 ? result.fileIds : undefined

    // Inform the Agent about files that couldn't be processed
    if (result.failedAttachments.length > 0) {
      const failedLines = result.failedAttachments
        .map((f) => `- ${f.fileName ?? f.mimeType ?? 'unknown file'}: ${f.reason}`)
        .join('\n')
      content += `\n\n[System: The user sent ${incoming.attachments.length} file(s), but ${result.failedAttachments.length} could not be processed:\n${failedLines}]`
    }
  }

  // Pre-generate ID so the queue item can self-reference as its own channelOriginId
  const originId = uuid()

  // Adapter-provided context line (already localized) for the conversation UI.
  // Built from the same `incoming.metadata` the LLM gets via <channel-context>,
  // but rendered as a subtle hint below the bubble — not injected in the prompt.
  let inboundContextLine: string | null = null
  if (incoming.metadata && Object.keys(incoming.metadata).length > 0) {
    const adapter = channelAdapters.get(channel.platform)
    if (adapter?.formatInboundContext) {
      try {
        const locale = resolveChannelLocale(channelId)
        inboundContextLine = adapter.formatInboundContext(incoming.metadata, locale)
      } catch (err) {
        log.warn({ channelId, err }, 'formatInboundContext threw, ignoring')
      }
    }
  }

  // One-shot transfer hint: when a transfer_channel call was made before
  // this inbound, surface the handoff context to the new Agent via the same
  // <channel-context> block. Consumed (popped) on first inbound after the
  // transfer; subsequent inbounds carry no hint.
  const transferHint = popChannelTransferHint(channelId)

  // Enqueue message to Agent's queue.
  // Channel adapters can attach free-form structured context via incoming.metadata
  // (modality, presence, channel info, etc.). It is stored under the `channel`
  // key of the user message metadata so the agent-engine can inject it as a
  // <channel-context> block in the prompt.
  const messageMetadata: Record<string, unknown> | undefined = (() => {
    const hasChannelMeta = incoming.metadata && Object.keys(incoming.metadata).length > 0
    if (!hasChannelMeta && !inboundContextLine && !transferHint) return undefined
    const out: Record<string, unknown> = {}
    if (hasChannelMeta) out.channel = incoming.metadata
    if (inboundContextLine) out.channelContextLine = inboundContextLine
    if (transferHint) out.channelTransfer = transferHint
    return out
  })()

  const { id: queueItemId } = await enqueueMessage({
    id: originId,
    agentId: channel.agentId,
    messageType: 'channel',
    content,
    sourceType: 'channel',
    sourceId: channelId,
    priority: config.queue.userPriority,
    fileIds,
    channelOriginId: originId,
    messageMetadata,
  })

  // Store channel metadata in one-shot sideband for direct channel response
  setChannelQueueMeta(queueItemId, {
    channelId,
    platformChatId: incoming.platformChatId,
    platformMessageId: incoming.platformMessageId,
    platformUserId: incoming.platformUserId,
  })

  // Store origin metadata for causal chain tracking (persists for follow-up turns)
  setChannelOriginMeta(originId, {
    channelId,
    platformChatId: incoming.platformChatId,
    platformMessageId: incoming.platformMessageId,
    platformUserId: incoming.platformUserId,
    createdAt: Date.now(),
    ttlMs: config.channels.pendingOriginTtlMs,
  })

  // Send typing indicator (fire-and-forget)
  const adapter = channelAdapters.get(channel.platform)
  if (adapter?.sendTypingIndicator) {
    const adapterCfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
    adapter.sendTypingIndicator(channel.id, adapterCfg, incoming.platformChatId).catch(() => {})
  }

  // Update stats
  await db
    .update(channels)
    .set({
      messagesReceived: channel.messagesReceived + 1,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(channels.id, channelId))

  // Emit SSE event for web UI
  sseManager.sendToAgent(channel.agentId, {
    type: 'channel:message-received',
    agentId: channel.agentId,
    data: { channelId, platform: channel.platform, sender: senderName },
  })

  log.info({ channelId, agentId: channel.agentId, sender: senderName, platform: channel.platform }, 'Channel message received')
}

// ─── Bot /start command ──────────────────────────────────────────────────────

async function handleBotStart(
  channel: typeof channels.$inferSelect,
  incoming: IncomingMessage,
  senderName: string,
) {
  // Fetch Agent info for the welcome message
  const agent = await db
    .select({ name: agents.name, role: agents.role })
    .from(agents)
    .where(eq(agents.id, channel.agentId))
    .get()

  const agentName = agent?.name ?? 'Agent'
  const agentRole = agent?.role ? ` — ${agent.role}` : ''
  const welcomeText = `Hi! I'm ${agentName}${agentRole}.\nSend me a message and I'll respond.`

  // Send welcome message via adapter
  const adapter = channelAdapters.get(channel.platform)
  if (adapter) {
    const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
    try {
      await adapter.sendMessage(channel.id, cfg, {
        chatId: incoming.platformChatId,
        content: welcomeText,
        replyToMessageId: incoming.platformMessageId,
      })
    } catch (err) {
      log.error({ channelId: channel.id, err }, 'Failed to send /start welcome message')
    }
  }

  // Update stats (count as received but not sent to Agent)
  await db
    .update(channels)
    .set({
      messagesReceived: channel.messagesReceived + 1,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(channels.id, channel.id))

  log.info({ channelId: channel.id, sender: senderName, platform: channel.platform }, 'Handled /start command')
}

// ─── Cross-Agent proactive send ───────────────────────────────────────────────

export interface SendToChannelAsParams {
  channelId: string
  /** The Agent actually sending. Drives the cross-Agent prefix + audit trail. */
  senderAgentId: string
  chatId: string
  content: string
  attachments?: OutboundAttachment[]
}

export interface SendToChannelAsResult {
  platformMessageId: string
  /** True when a `[AgentName]` prefix was prepended (sender ≠ channel owner). */
  prefixed: boolean
}

/**
 * Send a message proactively through a channel, on behalf of `senderAgentId`.
 *
 * Shared by send_channel_message and send_to_contact. Unlike
 * `deliverChannelResponse` (auto-delivery of an Agent reply tied to an assistant
 * `messages` row), this path has no originating message — it persists an audit
 * `channel_message_links` row with `messageId = null` and `sentByAgentId` set.
 *
 * Cross-Agent handling: when the sending Agent is NOT the channel owner
 * (channels.agentId), the message is prefixed with `[SenderAgentName] ` so the human
 * understands who is speaking through the borrowed bot, regardless of the
 * adapter's identitySwitchMode. When the sender IS the owner, no prefix is added
 * (preserves the historical single-Agent behaviour).
 *
 * Channel existence (not ownership) is the only gate — on a self-hosted
 * single-user instance every Agent is under the same control.
 */
export async function sendToChannelAs(
  params: SendToChannelAsParams,
): Promise<{ ok: true; result: SendToChannelAsResult } | { ok: false; error: string }> {
  const { channelId, senderAgentId, chatId, content, attachments } = params

  const channel = await getChannel(channelId)
  if (!channel) return { ok: false, error: 'Channel not found' }
  if (channel.status !== 'active') return { ok: false, error: 'Channel is not active' }

  const adapter = channelAdapters.get(channel.platform)
  if (!adapter) return { ok: false, error: `No adapter for platform ${channel.platform}` }

  // Cross-Agent prefix: only when the sender is not the channel owner.
  const isCrossAgent = senderAgentId !== channel.agentId
  let outboundContent = content
  let prefixed = false
  if (isCrossAgent) {
    const senderRow = db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, senderAgentId))
      .get()
    if (senderRow?.name) {
      const next = applyAgentNamePrefix(content, senderRow.name)
      prefixed = next !== content
      outboundContent = next
    }
  }

  try {
    const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
    const locale = resolveChannelLocale(channelId)
    const result = await adapter.sendMessage(channelId, cfg, {
      chatId,
      content: outboundContent,
      attachments: attachments?.length ? attachments : undefined,
      locale,
    })

    // Audit link: no originating assistant message, but record who sent it.
    await db.insert(channelMessageLinks).values({
      id: uuid(),
      channelId,
      messageId: null,
      platformMessageId: result.platformMessageId,
      platformChatId: chatId,
      direction: 'outbound',
      sentByAgentId: senderAgentId,
      createdAt: new Date(),
    })

    // Update stats
    await db
      .update(channels)
      .set({
        messagesSent: channel.messagesSent + 1,
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(channels.id, channelId))

    // SSE — broadcast to the channel owner so any open UI tab refreshes.
    sseManager.sendToAgent(channel.agentId, {
      type: 'channel:message-sent',
      agentId: channel.agentId,
      data: {
        channelId,
        platform: channel.platform,
        messageId: null,
        contextLine: result.contextLine ?? null,
      },
    })

    log.info(
      {
        channelId,
        ownerAgentId: channel.agentId,
        senderAgentId,
        crossAgent: isCrossAgent,
        prefix: prefixed,
        platform: channel.platform,
      },
      'Proactive channel message sent',
    )

    return { ok: true, result: { platformMessageId: result.platformMessageId, prefixed } }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

// ─── Response delivery ──────────────────────────────────────────────────────

export async function deliverChannelResponse(
  meta: ChannelQueueMeta,
  assistantMessageId: string,
  content: string,
  attachments?: OutboundAttachment[],
) {
  const channel = await getChannel(meta.channelId)
  if (!channel || channel.status !== 'active') return

  const adapter = channelAdapters.get(channel.platform)
  if (!adapter) {
    log.error({ channelId: meta.channelId }, 'No adapter found for response delivery')
    return
  }

  const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>

  // Identity prefix fallback. When the adapter does NOT switch identity
  // natively on the external platform, we prepend "[Agent Name] " to the
  // text content so the user knows which Agent is speaking after a
  // transfer_channel handoff. Precedence:
  //   - 'native': adapter pushed name/avatar to the platform itself,
  //               no prefix needed.
  //   - 'none':   neither switch nor prefix (caller opted out).
  //   - 'prefix' or undefined (default): prepend the prefix.
  // Skip when content is empty (attachments-only messages do not need
  // an identity hint).
  let outboundContent = content
  if (
    adapter.identitySwitchMode !== 'native' &&
    adapter.identitySwitchMode !== 'none' &&
    typeof content === 'string' &&
    content.trim().length > 0
  ) {
    const agentRow = db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, channel.agentId))
      .get()
    if (agentRow?.name) {
      outboundContent = applyAgentNamePrefix(content, agentRow.name)
    }
  }

  try {
    const locale = resolveChannelLocale(meta.channelId)
    const result = await adapter.sendMessage(meta.channelId, cfg, {
      chatId: meta.platformChatId,
      content: outboundContent,
      replyToMessageId: meta.platformMessageId,
      attachments: attachments?.length ? attachments : undefined,
      locale,
    })

    // Record the outbound link. Auto-delivered replies are authored by the
    // channel's current owner Agent, so sentByAgentId mirrors channel.agentId.
    await db.insert(channelMessageLinks).values({
      id: uuid(),
      channelId: meta.channelId,
      messageId: assistantMessageId,
      platformMessageId: result.platformMessageId,
      platformChatId: meta.platformChatId,
      direction: 'outbound',
      sentByAgentId: channel.agentId,
      createdAt: new Date(),
    })

    // Persist delivery context on the Agent's message so the UI can render a
    // "Sent on X via Y" hint under the bubble. Merge with whatever metadata
    // the engine already wrote.
    if (result.contextLine || result.deliveryMeta) {
      try {
        const existing = await db
          .select({ metadata: messages.metadata })
          .from(messages)
          .where(eq(messages.id, assistantMessageId))
          .get()
        let merged: Record<string, unknown> = {}
        if (existing?.metadata) {
          try { merged = JSON.parse(existing.metadata as string) as Record<string, unknown> } catch { /* corrupted, overwrite */ }
        }
        merged.channelDelivery = {
          platform: channel.platform,
          ...(result.contextLine ? { contextLine: result.contextLine } : {}),
          ...(result.deliveryMeta ? { meta: result.deliveryMeta } : {}),
        }
        await db
          .update(messages)
          .set({ metadata: JSON.stringify(merged) })
          .where(eq(messages.id, assistantMessageId))
      } catch (err) {
        log.warn({ messageId: assistantMessageId, err }, 'Failed to persist channelDelivery metadata')
      }
    }

    // Update stats
    await db
      .update(channels)
      .set({
        messagesSent: channel.messagesSent + 1,
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(channels.id, meta.channelId))

    // Emit SSE — include contextLine so the UI can refresh the message hint
    sseManager.sendToAgent(channel.agentId, {
      type: 'channel:message-sent',
      agentId: channel.agentId,
      data: {
        channelId: meta.channelId,
        platform: channel.platform,
        messageId: assistantMessageId,
        contextLine: result.contextLine ?? null,
      },
    })

    log.info({ channelId: meta.channelId, agentId: channel.agentId, platform: channel.platform }, 'Channel response delivered')
  } catch (err) {
    log.error({ channelId: meta.channelId, err }, 'Failed to deliver channel response')
  }
}

// ─── Asynchronous delivery-status updates (webhook status callbacks) ─────────

// Short localized labels for the delivery hint shown under the bubble. The
// status set is bounded (DeliveryStatus), so an inline map beats wiring the
// server into the client i18n bundle. Falls back to English, then to the raw
// status string for anything unmapped.
const DELIVERY_STATUS_LABELS: Record<string, Partial<Record<string, string>>> = {
  en: { delivered: 'Delivered', sent: 'Sent', queued: 'Queued', read: 'Read', undelivered: 'Delivery failed', failed: 'Delivery failed' },
  fr: { delivered: 'Remis', sent: 'Envoyé', queued: 'En file d’attente', read: 'Lu', undelivered: 'Échec de remise', failed: 'Échec de remise' },
  de: { delivered: 'Zugestellt', sent: 'Gesendet', queued: 'In Warteschlange', read: 'Gelesen', undelivered: 'Zustellung fehlgeschlagen', failed: 'Zustellung fehlgeschlagen' },
  es: { delivered: 'Entregado', sent: 'Enviado', queued: 'En cola', read: 'Leído', undelivered: 'Entrega fallida', failed: 'Entrega fallida' },
}

function buildDeliveryContextLine(update: DeliveryStatusUpdate, platformName: string, locale: string): string {
  const lang = (locale || 'en').slice(0, 2).toLowerCase()
  const labels = DELIVERY_STATUS_LABELS[lang] ?? DELIVERY_STATUS_LABELS.en ?? {}
  const label = labels[update.status] ?? update.status
  const isFailure = update.status === 'failed' || update.status === 'undelivered'
  const isSuccess = update.status === 'delivered' || update.status === 'read'
  const icon = isFailure ? '✗ ' : isSuccess ? '✓ ' : ''
  const errorSuffix = isFailure && update.errorCode ? ` (${update.errorCode})` : ''
  return `${icon}${label}${errorSuffix} · ${platformName}`
}

/**
 * Apply an asynchronous delivery-status update produced by a webhook-driven
 * channel (e.g. a Twilio MessageStatus callback). Correlates the provider's
 * message id back to the originating Agent message via `channelMessageLinks`,
 * refreshes the delivery hint stored on that message, and emits SSE so the
 * bubble updates live. No-op when the message id can't be correlated (e.g.
 * proactive sends with no originating message, or a callback that races the
 * link insert).
 */
export async function applyChannelDeliveryStatusUpdate(
  channelId: string,
  update: DeliveryStatusUpdate,
): Promise<void> {
  const channel = await getChannel(channelId)
  if (!channel) return

  const link = db
    .select({ messageId: channelMessageLinks.messageId })
    .from(channelMessageLinks)
    .where(
      and(
        eq(channelMessageLinks.channelId, channelId),
        eq(channelMessageLinks.platformMessageId, update.platformMessageId),
        eq(channelMessageLinks.direction, 'outbound'),
      ),
    )
    .orderBy(desc(channelMessageLinks.createdAt))
    .get()

  if (!link?.messageId) {
    log.info(
      { channelId, platformMessageId: update.platformMessageId, status: update.status },
      'Delivery status update with no linked message; skipping UI update',
    )
    return
  }

  const platformName = channelAdapters.get(channel.platform)?.meta?.displayName ?? channel.platform
  const locale = resolveChannelLocale(channelId)
  const contextLine = update.contextLine ?? buildDeliveryContextLine(update, platformName, locale)

  try {
    const existing = db
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.id, link.messageId))
      .get()
    let merged: Record<string, unknown> = {}
    if (existing?.metadata) {
      try { merged = JSON.parse(existing.metadata as string) as Record<string, unknown> } catch { /* corrupted, overwrite */ }
    }
    const prevDelivery =
      merged.channelDelivery && typeof merged.channelDelivery === 'object'
        ? (merged.channelDelivery as Record<string, unknown>)
        : {}
    merged.channelDelivery = {
      ...prevDelivery,
      platform: channel.platform,
      contextLine,
      deliveryStatus: update.status,
      ...(update.errorCode ? { errorCode: update.errorCode } : {}),
      ...(update.errorMessage ? { errorMessage: update.errorMessage } : {}),
    }
    await db
      .update(messages)
      .set({ metadata: JSON.stringify(merged) })
      .where(eq(messages.id, link.messageId))
  } catch (err) {
    log.warn({ messageId: link.messageId, err }, 'Failed to persist delivery status update')
    return
  }

  // Reuse channel:message-sent — the client already updates the message's
  // channelContextLine from this event, so the hint refreshes without a fetch.
  sseManager.sendToAgent(channel.agentId, {
    type: 'channel:message-sent',
    agentId: channel.agentId,
    data: {
      channelId,
      platform: channel.platform,
      messageId: link.messageId,
      contextLine,
    },
  })

  log.info(
    { channelId, agentId: channel.agentId, messageId: link.messageId, status: update.status, errorCode: update.errorCode },
    'Applied channel delivery status update',
  )
}

// ─── Channel transfer (UI + tool share this single entry point) ─────────────

export interface TransferChannelParams {
  channelId: string
  targetAgentId: string
  reason?: string
  /** Surfaced in the log line only; useful for ops traceability. */
  initiatedBy: 'tool' | 'ui'
  /** Calling Agent ID (tool flow). Logged for audit, not persisted. */
  calledByAgentId?: string
}

export type TransferChannelResult =
  | { ok: true; noop: true; message: string }
  | {
      ok: true
      noop?: false
      transferredAt: number
      previousAgentSlug: string
      newAgentSlug: string
      fromAgentId: string
      fromAgentName: string
      toAgentId: string
      toAgentName: string
    }
  | { ok: false; error: string }

/**
 * Re-bind a channel to a different Agent at runtime. Single source of truth for
 * both the transfer_channel tool and the REST endpoint
 * POST /api/channels/:id/transfer. Wraps:
 *
 *   1. Validation: channel exists, target Agent exists, no-op detection.
 *   2. channels.agentId mutation.
 *   3. Two role='system' audit-trail messages (one per Agent, with
 *      metadata.systemEvent set so buildMessageHistory can filter them out
 *      of the LLM prompt and the UI can render them as handoff banners).
 *   4. Sideband channelTransferHint for the next inbound's <channel-context>.
 *   5. SSE 'channel:transferred' broadcast.
 *   6. Best-effort adapter.onIdentityChange (warn on failure).
 *
 * Callers should never re-implement any of these steps directly; the only
 * place channels.agentId is mutated should be here.
 */
export async function transferChannel(params: TransferChannelParams): Promise<TransferChannelResult> {
  const channel = await getChannel(params.channelId)
  if (!channel) {
    return { ok: false, error: `Channel "${params.channelId}" not found.` }
  }

  if (channel.agentId === params.targetAgentId) {
    return { ok: true, noop: true, message: 'Channel is already bound to this Agent.' }
  }

  const fromAgentRow = db
    .select({ id: agents.id, slug: agents.slug, name: agents.name })
    .from(agents)
    .where(eq(agents.id, channel.agentId))
    .get()
  if (!fromAgentRow) {
    return { ok: false, error: `Source Agent "${channel.agentId}" not found; refusing to transfer from a dangling binding.` }
  }
  const toAgentRow = db
    .select({ id: agents.id, slug: agents.slug, name: agents.name, avatarPath: agents.avatarPath, updatedAt: agents.updatedAt })
    .from(agents)
    .where(eq(agents.id, params.targetAgentId))
    .get()
  if (!toAgentRow) {
    return { ok: false, error: `Target Agent "${params.targetAgentId}" not found; refusing to transfer to a dangling binding.` }
  }

  const fromAgentId = fromAgentRow.id
  const fromAgentSlug = fromAgentRow.slug ?? fromAgentRow.id
  const fromAgentName = fromAgentRow.name
  const toAgentId = toAgentRow.id
  const toAgentSlug = toAgentRow.slug ?? toAgentRow.id
  const toAgentName = toAgentRow.name

  const at = Date.now()
  const now = new Date(at)

  // (2) Mutate the binding.
  await db
    .update(channels)
    .set({ agentId: toAgentId, updatedAt: now })
    .where(eq(channels.id, channel.id))

  // (3) Audit-trail rows. Same content/shape as before the extraction so the
  //     UI rendering and prompt filtering continue to work unchanged.
  const reasonOrNull = params.reason ?? null
  const outMetaJson = JSON.stringify({
    systemEvent: 'channel_transferred_out',
    channelId: channel.id,
    channelName: channel.name,
    targetAgentId: toAgentId,
    targetAgentSlug: toAgentSlug,
    targetAgentName: toAgentName,
    reason: reasonOrNull,
    at,
  })
  const inMetaJson = JSON.stringify({
    systemEvent: 'channel_transferred_in',
    channelId: channel.id,
    channelName: channel.name,
    fromAgentId,
    fromAgentSlug,
    fromAgentName,
    reason: reasonOrNull,
    at,
  })
  await db.insert(messages).values({
    id: uuid(),
    agentId: fromAgentId,
    role: 'system',
    content: null,
    sourceType: 'system',
    sourceId: null,
    metadata: outMetaJson,
    createdAt: now,
  })
  await db.insert(messages).values({
    id: uuid(),
    agentId: toAgentId,
    role: 'system',
    content: null,
    sourceType: 'system',
    sourceId: null,
    metadata: inMetaJson,
    createdAt: now,
  })

  // (4) One-shot sideband hint for the next inbound.
  setChannelTransferHint(channel.id, {
    fromAgentId,
    fromAgentSlug,
    fromAgentName,
    reason: params.reason,
    at,
  })

  // (5) Live UI broadcast.
  sseManager.broadcast({
    type: 'channel:transferred',
    data: {
      channelId: channel.id,
      channelName: channel.name,
      platform: channel.platform,
      fromAgentId,
      fromAgentSlug,
      fromAgentName,
      toAgentId,
      toAgentSlug,
      toAgentName,
      reason: reasonOrNull,
      at,
    },
  })

  // (6) Best-effort native identity switch on the external platform.
  const adapter = channelAdapters.get(channel.platform)
  if (adapter && typeof adapter.onIdentityChange === 'function') {
    try {
      const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
      const relAvatar = agentAvatarUrl(toAgentId, toAgentRow.avatarPath, toAgentRow.updatedAt)
      const avatarUrl = relAvatar ? `${config.publicUrl}${relAvatar}` : undefined
      await adapter.onIdentityChange(channel.id, cfg, {
        agentSlug: toAgentSlug,
        agentName: toAgentName,
        avatarUrl,
      })
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), channelId: channel.id, newAgentSlug: toAgentSlug },
        'onIdentityChange failed (non-fatal); the prefix fallback (if any) still applies',
      )
    }
  }

  log.info(
    {
      initiatedBy: params.initiatedBy,
      calledByAgentId: params.calledByAgentId ?? null,
      channelId: channel.id,
      fromAgentId,
      toAgentId,
      reason: reasonOrNull,
    },
    'Channel transferred',
  )

  return {
    ok: true,
    transferredAt: at,
    previousAgentSlug: fromAgentSlug,
    newAgentSlug: toAgentSlug,
    fromAgentId,
    fromAgentName,
    toAgentId,
    toAgentName,
  }
}

// ─── Contact resolution ─────────────────────────────────────────────────────

/** Look up a contact by (platform, platformId) in the contactPlatformIds table */
export function findContactByPlatformId(platform: string, platformId: string) {
  const row = db
    .select({ contactId: contactPlatformIds.contactId })
    .from(contactPlatformIds)
    .where(and(eq(contactPlatformIds.platform, platform), eq(contactPlatformIds.platformId, platformId)))
    .get()

  return row ? db.select().from(contacts).where(eq(contacts.id, row.contactId)).get() ?? null : null
}

interface ResolvedChannelUser {
  contact: typeof contacts.$inferSelect | null
  /** Non-null only when the user is pending approval */
  pendingMappingId: string | null
}

async function resolveChannelContact(
  channel: typeof channels.$inferSelect,
  incoming: IncomingMessage,
): Promise<ResolvedChannelUser> {
  // 1. Check contactPlatformIds — authorized contact?
  const contact = findContactByPlatformId(channel.platform, incoming.platformUserId)
  if (contact) {
    return { contact, pendingMappingId: null }
  }

  // 2. Check for existing pending mapping on this channel
  const existingMapping = await db
    .select()
    .from(channelUserMappings)
    .where(
      and(
        eq(channelUserMappings.channelId, channel.id),
        eq(channelUserMappings.platformUserId, incoming.platformUserId),
      ),
    )
    .get()

  if (existingMapping) {
    // Update metadata (username, display name may have changed)
    await db
      .update(channelUserMappings)
      .set({
        platformUsername: incoming.platformUsername ?? existingMapping.platformUsername,
        platformDisplayName: incoming.platformDisplayName ?? existingMapping.platformDisplayName,
        updatedAt: new Date(),
      })
      .where(eq(channelUserMappings.id, existingMapping.id))

    return { contact: null, pendingMappingId: existingMapping.id }
  }

  // 3. New user — create pending mapping + broadcast
  const now = new Date()
  const mappingId = uuid()
  await db.insert(channelUserMappings).values({
    id: mappingId,
    channelId: channel.id,
    platformUserId: incoming.platformUserId,
    platformUsername: incoming.platformUsername ?? null,
    platformDisplayName: incoming.platformDisplayName ?? null,
    contactId: null,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  })

  sseManager.broadcast({
    type: 'channel:user-pending',
    agentId: channel.agentId,
    data: {
      channelId: channel.id,
      mappingId,
      platformUsername: incoming.platformUsername,
      platformDisplayName: incoming.platformDisplayName,
      platform: channel.platform,
    },
  })

  // Persistent notification
  const { createNotification } = await import('@/server/services/notifications')
  createNotification({
    type: 'channel:user-pending',
    title: 'New user awaiting approval',
    body: `${incoming.platformDisplayName ?? incoming.platformUsername ?? incoming.platformUserId} on ${channel.name}`,
    agentId: channel.agentId,
    relatedId: channel.id,
    relatedType: 'channel',
  }).catch(() => {})

  log.info(
    { channelId: channel.id, platformUserId: incoming.platformUserId, platform: channel.platform },
    'New channel user pending approval',
  )

  return { contact: null, pendingMappingId: mappingId }
}

// ─── User mappings (pending only) ───────────────────────────────────────────

export async function listPendingUsers(channelId: string) {
  return db
    .select({
      id: channelUserMappings.id,
      channelId: channelUserMappings.channelId,
      platformUserId: channelUserMappings.platformUserId,
      platformUsername: channelUserMappings.platformUsername,
      platformDisplayName: channelUserMappings.platformDisplayName,
      createdAt: channelUserMappings.createdAt,
    })
    .from(channelUserMappings)
    .where(and(eq(channelUserMappings.channelId, channelId), eq(channelUserMappings.status, 'pending')))
    .orderBy(desc(channelUserMappings.createdAt))
    .all()
}

// ─── Approval ───────────────────────────────────────────────────────────────

type ApproveParams =
  | { action: 'create'; name?: string }
  | { action: 'link'; contactId: string }

export async function approveChannelUser(mappingId: string, params: ApproveParams) {
  const mapping = await db.select().from(channelUserMappings).where(eq(channelUserMappings.id, mappingId)).get()
  if (!mapping) return null

  const channel = await getChannel(mapping.channelId)
  if (!channel) return null

  const now = new Date()
  let contactId: string

  if (params.action === 'create') {
    // Create a new contact with the platform ID pre-filled.
    // Use the user-provided name as firstName, falling back to platform metadata as a nickname.
    const rawName = params.name?.trim()
    const fallbackNick = mapping.platformDisplayName ?? mapping.platformUsername ?? `${channel.platform}:${mapping.platformUserId}`
    const result = await createContact(
      rawName
        ? { firstName: rawName }
        : { nicknames: [fallbackNick] },
    )
    if ('error' in result) throw new Error(`User already linked to "${result.linkedContactName}"`)
    contactId = result.id
    log.info({ mappingId, contactId, firstName: rawName ?? null }, 'Created contact on approval')
  } else {
    // Link to an existing contact — verify it exists
    const existing = await db.select().from(contacts).where(eq(contacts.id, params.contactId)).get()
    if (!existing) throw new Error('Contact not found')
    contactId = params.contactId
  }

  // Insert platform ID linking (platform, platformUserId) → contact
  await db.insert(contactPlatformIds).values({
    id: uuid(),
    contactId,
    platform: channel.platform,
    platformId: mapping.platformUserId,
    createdAt: now,
    updatedAt: now,
  })

  // Delete this pending mapping
  await db.delete(channelUserMappings).where(eq(channelUserMappings.id, mappingId))

  // Clean up any other pending mappings for the same (platform, platformUserId) on other channels
  // since the user is now globally authorized via contactPlatformIds
  const otherMappings = await db
    .select({ id: channelUserMappings.id, channelId: channelUserMappings.channelId })
    .from(channelUserMappings)
    .where(
      and(
        eq(channelUserMappings.platformUserId, mapping.platformUserId),
        eq(channelUserMappings.status, 'pending'),
      ),
    )
    .all()

  // We need to know which channels share the same platform to clean up cross-channel mappings
  for (const other of otherMappings) {
    const otherChannel = await getChannel(other.channelId)
    if (otherChannel?.platform === channel.platform) {
      await db.delete(channelUserMappings).where(eq(channelUserMappings.id, other.id))
      // Broadcast approval on those channels too
      sseManager.broadcast({
        type: 'channel:user-approved',
        agentId: otherChannel.agentId,
        data: { channelId: other.channelId, mappingId: other.id },
      })
    }
  }

  // Broadcast SSE for the primary channel
  sseManager.broadcast({
    type: 'channel:user-approved',
    agentId: channel.agentId,
    data: { channelId: mapping.channelId, mappingId },
  })

  // Send approval notification to the user on the platform
  const adapter = channelAdapters.get(channel.platform)
  if (adapter) {
    const adapterCfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
    adapter.sendMessage(channel.id, adapterCfg, {
      chatId: mapping.platformUserId,
      content: 'Your access has been approved! You can now send messages.',
    }).catch((err) => log.warn({ channelId: channel.id, err }, 'Failed to send approval notification'))
  }

  log.info({ mappingId, channelId: mapping.channelId, contactId }, 'Channel user approved')
  return { contactId }
}

export async function countPendingApprovals(): Promise<number> {
  const result = await db
    .select({ value: count() })
    .from(channelUserMappings)
    .where(eq(channelUserMappings.status, 'pending'))
    .get()
  return result?.value ?? 0
}

export async function countPendingApprovalsForChannel(channelId: string): Promise<number> {
  const result = await db
    .select({ value: count() })
    .from(channelUserMappings)
    .where(and(eq(channelUserMappings.channelId, channelId), eq(channelUserMappings.status, 'pending')))
    .get()
  return result?.value ?? 0
}

// ─── Contact platform IDs ───────────────────────────────────────────────────

export function listContactPlatformIds(contactId: string) {
  return db
    .select({
      id: contactPlatformIds.id,
      contactId: contactPlatformIds.contactId,
      platform: contactPlatformIds.platform,
      platformId: contactPlatformIds.platformId,
      createdAt: contactPlatformIds.createdAt,
    })
    .from(contactPlatformIds)
    .where(eq(contactPlatformIds.contactId, contactId))
    .all()
}

export function removeContactPlatformId(id: string, contactId?: string): boolean {
  const existing = db.select().from(contactPlatformIds).where(eq(contactPlatformIds.id, id)).get()
  if (!existing) return false
  if (contactId && existing.contactId !== contactId) return false
  db.delete(contactPlatformIds).where(eq(contactPlatformIds.id, id)).run()
  log.info({ id, contactId: existing.contactId, platform: existing.platform, platformId: existing.platformId }, 'Contact platform ID removed (access revoked)')

  sseManager.broadcast({
    type: 'contact:updated',
    data: { contactId: existing.contactId },
  })

  return true
}

export function addContactPlatformId(contactId: string, platform: string, platformId: string) {
  const now = new Date()
  const id = uuid()
  db.insert(contactPlatformIds).values({
    id,
    contactId,
    platform,
    platformId,
    createdAt: now,
    updatedAt: now,
  }).run()

  sseManager.broadcast({
    type: 'contact:updated',
    data: { contactId },
  })

  return { id, contactId, platform, platformId, createdAt: now }
}

// ─── Known conversations (for proactive messaging) ──────────────────────────

export async function listChannelConversations(channelId: string) {
  const channel = await getChannel(channelId)
  if (!channel) return { users: [], knownChatIds: [] }

  // Get authorized users for this channel's platform from contactPlatformIds
  const platformUsers = db
    .select({
      platformId: contactPlatformIds.platformId,
      contactId: contactPlatformIds.contactId,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
    })
    .from(contactPlatformIds)
    .innerJoin(contacts, eq(contactPlatformIds.contactId, contacts.id))
    .where(eq(contactPlatformIds.platform, channel.platform))
    .all()

  // Also include pending users from mappings
  const pendingUsers = await db
    .select({
      platformUserId: channelUserMappings.platformUserId,
      platformUsername: channelUserMappings.platformUsername,
      platformDisplayName: channelUserMappings.platformDisplayName,
    })
    .from(channelUserMappings)
    .where(and(eq(channelUserMappings.channelId, channelId), eq(channelUserMappings.status, 'pending')))
    .all()

  // Get distinct chat IDs from message links (covers both DMs and groups)
  const links = await db
    .select({
      platformChatId: channelMessageLinks.platformChatId,
    })
    .from(channelMessageLinks)
    .where(eq(channelMessageLinks.channelId, channelId))
    .all()

  const distinctChatIds = [...new Set(links.map((l) => l.platformChatId))]

  // Merge authorized + pending users
  const users = [
    ...platformUsers.map((u) => ({
      platformUserId: u.platformId,
      chatId: u.platformId, // For Telegram DMs, chatId = userId
      username: null as string | null,
      displayName: getContactDisplayName({ firstName: u.firstName, lastName: u.lastName }),
    })),
    ...pendingUsers.map((m) => ({
      platformUserId: m.platformUserId,
      chatId: m.platformUserId,
      username: m.platformUsername,
      displayName: m.platformDisplayName,
    })),
  ]

  return { users, knownChatIds: distinctChatIds }
}

// ─── Active channels for an Agent (for prompt builder) ─────────────────────────

export async function getActiveChannelsForAgent(agentId: string) {
  return db
    .select()
    .from(channels)
    .where(and(eq(channels.agentId, agentId), eq(channels.status, 'active')))
    .all()
}

// ─── Startup: restore active channels ───────────────────────────────────────

export async function restoreActiveChannels() {
  const activeChannels = await db
    .select()
    .from(channels)
    .where(eq(channels.status, 'active'))
    .all()

  log.info({ count: activeChannels.length }, 'Restoring active channels')

  for (const channel of activeChannels) {
    const adapter = channelAdapters.get(channel.platform)
    if (!adapter) {
      log.warn({ channelId: channel.id, platform: channel.platform }, 'No adapter for active channel, marking as error')
      await setChannelStatus(channel.id, 'error', `No adapter for platform "${channel.platform}"`)
      continue
    }

    const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
    try {
      await adapter.start(channel.id, cfg, (incoming) => handleIncomingChannelMessage(channel.id, incoming))
      log.info({ channelId: channel.id, platform: channel.platform }, 'Channel restored')
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error'
      await setChannelStatus(channel.id, 'error', errMsg)
      log.error({ channelId: channel.id, err: errMsg }, 'Failed to restore channel')
    }
  }
}
