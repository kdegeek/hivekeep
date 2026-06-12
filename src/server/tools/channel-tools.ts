import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import {
  listChannels,
  listChannelsWithOwners,
  getChannel,
  listChannelConversations,
  createChannel,
  updateChannel,
  deleteChannel,
  activateChannel,
  deactivateChannel,
  getChannelOriginMeta,
  transferChannel,
  sendToChannelAs,
} from '@/server/services/channels'
import { searchContacts, getContactWithDetails } from '@/server/services/contacts'
import { resolveAgentId } from '@/server/services/agent-resolver'
import { channelAdapters } from '@/server/channels/index'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'
import type { OutboundAttachment } from '@/server/channels/adapter'
import type { ChannelPlatform } from '@/shared/types'

const log = createLogger('tools:channel')

/**
 * list_channels — list all messaging channels connected to this Agent.
 * Available to main agents only.
 */
export const listChannelsTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'List messaging channels. By default (scope="mine") returns only channels bound to this Agent. Pass scope="all" to discover every channel on the platform, including those owned by other Agents (each result then carries ownerAgentId/ownerAgentSlug/ownerAgentName). You can send through another Agent\'s channel via send_channel_message — your message is automatically prefixed with your Agent name.',
      inputSchema: z.object({
        scope: z
          .enum(['mine', 'all'])
          .optional()
          .describe('"mine" (default) = only this Agent\'s channels. "all" = every channel on the platform.'),
      }),
      execute: async ({ scope }) => {
        if (scope === 'all') {
          const items = await listChannelsWithOwners()
          return {
            channels: items.map((ch) => ({
              id: ch.id,
              name: ch.name,
              platform: ch.platform,
              status: ch.status,
              ownerAgentId: ch.agentId,
              ownerAgentSlug: ch.ownerAgentSlug,
              ownerAgentName: ch.ownerAgentName,
              owned: ch.agentId === ctx.agentId,
              messagesReceived: ch.messagesReceived,
              messagesSent: ch.messagesSent,
              lastActivityAt: ch.lastActivityAt
                ? new Date(ch.lastActivityAt as unknown as number).toISOString()
                : null,
            })),
          }
        }
        const items = await listChannels(ctx.agentId)
        return {
          channels: items.map((ch) => ({
            id: ch.id,
            name: ch.name,
            platform: ch.platform,
            status: ch.status,
            messagesReceived: ch.messagesReceived,
            messagesSent: ch.messagesSent,
            lastActivityAt: ch.lastActivityAt
              ? new Date(ch.lastActivityAt as unknown as number).toISOString()
              : null,
          })),
        }
      },
    }),
}

/**
 * list_channel_conversations — list known users and chat IDs for a channel.
 * Useful for proactive messaging: the Agent needs a chat_id to send messages.
 */
export const listChannelConversationsTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'List known users and chat IDs for a channel. Use to discover who you can message proactively.',
      inputSchema: z.object({
        channel_id: z.string(),
      }),
      execute: async ({ channel_id }) => {
        // Existence-only check: cross-Agent discovery is allowed (single-user
        // self-hosted instance). Ownership is not required to read a channel's
        // conversations.
        const channel = await getChannel(channel_id)
        if (!channel) {
          return { error: 'Channel not found' }
        }
        return await listChannelConversations(channel_id)
      },
    }),
}

/**
 * send_channel_message — proactively send a message to an external platform.
 * Enabled by default for main agents. Use `send_to_contact` when you want
 * to address a contact by name without having to look up their chat_id.
 */
export const sendChannelMessageTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Send a message to an external platform via a connected channel. Requires a known platform chat/user id — use send_to_contact when you only know the contact by name.',
      inputSchema: z.object({
        channel_id: z.string(),
        chat_id: z.string().describe('Platform chat/user ID to send to'),
        message: z.string(),
        attachments: z.array(z.object({
          source: z.string().describe('Absolute file path or URL'),
          mimeType: z.string(),
          fileName: z.string().optional(),
        })).optional(),
      }),
      execute: async ({ channel_id, chat_id, message, attachments }) => {
        log.debug({ agentId: ctx.agentId, channelId: channel_id, chatId: chat_id }, 'Channel message send requested')

        // Existence-only check: an Agent may borrow another Agent's channel. When the
        // caller is not the channel owner, sendToChannelAs prefixes the message
        // with the caller's Agent name and records sentByAgentId for audit.
        const outboundAttachments: OutboundAttachment[] | undefined = attachments?.map(a => ({
          source: a.source,
          mimeType: a.mimeType,
          fileName: a.fileName,
        }))
        const sent = await sendToChannelAs({
          channelId: channel_id,
          senderAgentId: ctx.agentId,
          chatId: chat_id,
          content: message,
          attachments: outboundAttachments,
        })
        if (!sent.ok) {
          return { error: sent.error }
        }
        return {
          success: true,
          platformMessageId: sent.result.platformMessageId,
          prefixed: sent.result.prefixed,
        }
      },
    }),
}

/**
 * list_endpoints — surface the destinations an Agent can post to within a
 * connected channel. Examples: Discord guild channels + DM threads,
 * TeamSpeak rooms, Matrix joined rooms, Telegram groups.
 *
 * Cached per channel for 60s — most adapters round-trip the platform
 * API to enumerate, and the list rarely changes between back-to-back
 * Agent turns. Cache is in-memory; restart clears it.
 *
 * Adapters where every destination is implicitly tied to a contact
 * (Twilio SMS, Signal) don't implement `listEndpoints` — the tool
 * returns a clear error pointing the Agent at `send_to_contact`.
 */
export const listEndpointsTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'List the destinations (channels, rooms, groups, DMs) reachable inside a connected channel. Use the returned `id` as the `chat_id` argument to send_channel_message.',
      inputSchema: z.object({
        channel_id: z.string(),
      }),
      execute: async ({ channel_id }) => {
        // Existence-only check: cross-Agent endpoint discovery is allowed.
        const channel = await getChannel(channel_id)
        if (!channel) {
          return { error: 'Channel not found' }
        }

        const adapter = channelAdapters.get(channel.platform)
        if (!adapter) {
          return { error: `No adapter for platform ${channel.platform}` }
        }
        if (!adapter.listEndpoints) {
          return {
            error: `Platform "${channel.platform}" doesn't expose endpoint discovery. Each destination on this platform is tied to a contact — use send_to_contact instead.`,
          }
        }

        const cacheKey = `${channel_id}`
        const cached = endpointsCache.get(cacheKey)
        if (cached && Date.now() - cached.fetchedAt < ENDPOINTS_CACHE_TTL_MS) {
          return { endpoints: cached.data, cached: true }
        }

        try {
          const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
          const endpoints = await adapter.listEndpoints(channel_id, cfg)
          endpointsCache.set(cacheKey, { data: endpoints, fetchedAt: Date.now() })
          return { endpoints }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      },
    }),
}

/** Per-channel cache for listEndpoints — most platforms cost a REST
 *  round-trip to enumerate; the list rarely changes between Agent turns. */
const ENDPOINTS_CACHE_TTL_MS = 60_000
const endpointsCache = new Map<string, { data: unknown; fetchedAt: number }>()

/**
 * send_to_contact — proactively message a contact on a specific platform.
 *
 * Higher-level wrapper around `send_channel_message`. Resolves the
 * contact by name/id, looks up their platform identifier (e.g. their
 * phone number for `twilio-sms`, Telegram user id, Matrix mxid, …),
 * finds an active channel of the right platform owned by this Agent,
 * and dispatches the message.
 *
 * Available to main agents — enabled by default since the resolution
 * step is bounded and any ambiguity returns an error instead of
 * picking blindly.
 */
export const sendToContactTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Proactively send a message to a known contact on a specific platform. Resolves the contact + platform id automatically — give the contact name (or id) and the platform slug (e.g. "twilio-sms", "telegram", "matrix"). Returns an error if the contact is ambiguous, has no identifier for that platform, or this Agent has no active channel for it.',
      inputSchema: z.object({
        contact: z.string().describe('Contact name, display name, nickname, or contact id'),
        platform: z.string().describe('Platform slug, e.g. "twilio-sms", "telegram", "matrix", or a plugin platform like "plugin:hivekeep-plugin-teamspeak:teamspeak"'),
        message: z.string(),
        attachments: z.array(z.object({
          source: z.string().describe('Absolute file path or URL'),
          mimeType: z.string(),
          fileName: z.string().optional(),
        })).optional(),
      }),
      execute: async ({ contact, platform, message, attachments }) => {
        log.debug({ agentId: ctx.agentId, contact, platform }, 'send_to_contact requested')

        // 1) Resolve the contact. Try id first, then a fuzzy search.
        let contactRecord = await getContactWithDetails(contact, ctx.agentId)
        if (!contactRecord) {
          const matches = await searchContacts(contact, ctx.agentId)
          if (matches.length === 0) {
            return { error: `No contact matches "${contact}". Use search_contacts or create_contact first.` }
          }
          if (matches.length > 1) {
            return {
              error: `Ambiguous contact "${contact}" — ${matches.length} matches. Resolve by id.`,
              candidates: matches.slice(0, 5).map((m) => ({ id: m.id, displayName: m.displayName })),
            }
          }
          contactRecord = matches[0]!
        }

        // 2) Find the contact's platform identifier for the requested platform.
        const platformLink = contactRecord.platformIds.find((p) => p.platform === platform)
        if (!platformLink) {
          return {
            error: `Contact "${contactRecord.displayName}" has no identifier for platform "${platform}". Available platforms: ${contactRecord.platformIds.map((p) => p.platform).join(', ') || '(none)'}.`,
          }
        }

        // 3) Find an active channel of this platform. Prefer one owned by the
        //    calling Agent; fall back to any active channel of that platform on
        //    the instance (cross-Agent send). listChannels() with no agentId returns
        //    every channel.
        const allChannels = await listChannels()
        const platformChannels = allChannels.filter((c) => c.platform === platform)
        const channel =
          platformChannels.find((c) => c.agentId === ctx.agentId && c.status === 'active') ??
          platformChannels.find((c) => c.status === 'active')
        if (!channel) {
          if (platformChannels.length === 0) {
            return { error: `No channel configured for platform "${platform}". Add one via create_channel.` }
          }
          return { error: `No active channel for platform "${platform}" (statuses: ${platformChannels.map((c) => c.status).join(', ')}).` }
        }

        // 4) Dispatch via the shared cross-Agent send path. When `channel` is owned
        //    by another Agent, the message is prefixed with this Agent's name and
        //    sentByAgentId is recorded for audit.
        const outboundAttachments: OutboundAttachment[] | undefined = attachments?.map((a) => ({
          source: a.source,
          mimeType: a.mimeType,
          fileName: a.fileName,
        }))
        const sent = await sendToChannelAs({
          channelId: channel.id,
          senderAgentId: ctx.agentId,
          chatId: platformLink.platformId,
          content: message,
          attachments: outboundAttachments,
        })
        if (!sent.ok) {
          return { error: sent.error }
        }
        return {
          success: true,
          platformMessageId: sent.result.platformMessageId,
          prefixed: sent.result.prefixed,
          sentTo: { contactId: contactRecord.id, displayName: contactRecord.displayName, platform, chatId: platformLink.platformId },
        }
      },
    }),
}

/**
 * create_channel — create a new messaging channel for this Agent.
 * Opt-in tool (defaultDisabled). Available to main agents only.
 */
export const createChannelTool: ToolRegistration = {
  availability: ['main'],
  defaultDisabled: true,
  create: (ctx) =>
    tool({
      description:
        'Create a new messaging channel. The `config` keys must match the platform\'s declared configuration fields (e.g. Telegram needs `botToken`; Slack needs `botToken` + `signingSecret`; WhatsApp needs `accessToken` + `phoneNumberId` + `verifyToken`; Matrix needs `homeserverUrl` + `accessToken`). Password-type fields are auto-vaulted by the server — fetch secret values from Vault via get_secret() rather than hardcoding them. If you don\'t know the expected fields for a platform, attempt the call: the validation error lists what\'s missing.',
      inputSchema: z.object({
        name: z.string(),
        platform: z.string().describe('e.g. "telegram", "discord", "slack", "whatsapp", "signal", "matrix", or a plugin platform'),
        config: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .describe('Configuration values keyed by adapter field name (e.g. { botToken: "..." } for Telegram, { botToken: "...", signingSecret: "..." } for Slack).'),
        allowed_chat_ids: z.array(z.string()).optional().describe('Restrict to specific chat/group IDs'),
        auto_create_contacts: z.boolean().optional().describe('Default: true'),
      }),
      execute: async ({ name, platform, config, allowed_chat_ids, auto_create_contacts }) => {
        log.debug({ agentId: ctx.agentId, platform, name, configKeys: Object.keys(config) }, 'Channel creation requested')

        if (!channelAdapters.get(platform)) {
          return { error: `Unknown platform "${platform}". Available: ${channelAdapters.list().join(', ')}` }
        }

        try {
          const channel = await createChannel({
            agentId: ctx.agentId,
            name,
            platform: platform as ChannelPlatform,
            platformConfig: config,
            allowedChatIds: allowed_chat_ids,
            autoCreateContacts: auto_create_contacts,
            createdBy: 'agent',
          })
          return {
            success: true,
            channel: {
              id: channel.id,
              name: channel.name,
              platform: channel.platform,
              status: channel.status,
            },
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      },
    }),
}

/**
 * update_channel — update an existing channel's configuration.
 * Opt-in tool (defaultDisabled). Available to main agents only.
 */
export const updateChannelTool: ToolRegistration = {
  availability: ['main'],
  defaultDisabled: true,
  create: (ctx) =>
    tool({
      description:
        'Update a channel\'s configuration (name, chat restrictions, auto-contact).',
      inputSchema: z.object({
        channel_id: z.string(),
        name: z.string().optional(),
        allowed_chat_ids: z.array(z.string()).optional().describe('Empty array to remove restrictions'),
        auto_create_contacts: z.boolean().optional(),
      }),
      execute: async ({ channel_id, name, allowed_chat_ids, auto_create_contacts }) => {
        const channel = await getChannel(channel_id)
        if (!channel || channel.agentId !== ctx.agentId) {
          return { error: 'Channel not found' }
        }

        try {
          const updated = await updateChannel(channel_id, {
            name,
            allowedChatIds: allowed_chat_ids?.length ? allowed_chat_ids : allowed_chat_ids?.length === 0 ? null : undefined,
            autoCreateContacts: auto_create_contacts,
          })
          if (!updated) return { error: 'Update failed' }
          return {
            success: true,
            channel: {
              id: updated.id,
              name: updated.name,
              platform: updated.platform,
              status: updated.status,
            },
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      },
    }),
}

/**
 * delete_channel — permanently delete a channel.
 * Opt-in tool (defaultDisabled). Available to main agents only.
 */
export const deleteChannelTool: ToolRegistration = {
  availability: ['main'],
  defaultDisabled: true,
  destructive: true,
  create: (ctx) =>
    tool({
      description:
        'Permanently delete a messaging channel. Only use when explicitly asked.',
      inputSchema: z.object({
        channel_id: z.string(),
      }),
      execute: async ({ channel_id }) => {
        const channel = await getChannel(channel_id)
        if (!channel || channel.agentId !== ctx.agentId) {
          return { error: 'Channel not found' }
        }

        try {
          const deleted = await deleteChannel(channel_id)
          return deleted ? { success: true } : { error: 'Delete failed' }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      },
    }),
}

/**
 * activate_channel — activate an inactive channel (start listening).
 * Available to main agents only.
 */
export const activateChannelTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description: 'Activate an inactive channel to start listening for messages.',
      inputSchema: z.object({
        channel_id: z.string(),
      }),
      execute: async ({ channel_id }) => {
        const channel = await getChannel(channel_id)
        if (!channel || channel.agentId !== ctx.agentId) {
          return { error: 'Channel not found' }
        }

        if (channel.status === 'active') {
          return { error: 'Channel is already active' }
        }

        try {
          const activated = await activateChannel(channel_id)
          if (!activated) return { error: 'Activation failed' }
          return {
            success: activated.status === 'active',
            status: activated.status,
            statusMessage: activated.statusMessage,
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      },
    }),
}

/**
 * transfer_channel — re-bind a channel to a different Agent at runtime.
 *
 * Any Agent can call this (no "channel owner" restriction). Effects:
 *   - channels.agentId is mutated to the target Agent.
 *   - Two role='system' audit-trail messages are inserted, one per Agent, with
 *     metadata.systemEvent='channel_transferred_out' / 'channel_transferred_in'.
 *     buildMessageHistory filters these out of the LLM prompt; the UI renders
 *     them as a handoff banner.
 *   - A one-shot channelTransferHint is stashed in the sideband. The next
 *     inbound on the channel pops it and surfaces the handoff via
 *     <channel-context> to the new Agent on its first turn.
 *   - SSE 'channel:transferred' is broadcast so any open UI tab updates the
 *     sidebar binding badge in real time.
 *
 * No turn is triggered on the new Agent at transfer time. The new Agent discovers
 * the conversation when the user next sends a message.
 */
export const transferChannelTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Transfer a channel binding to another Agent. The target Agent will receive the next inbound message on this channel (no immediate turn is triggered). Both Agents get a visible audit-trail row in their conversation. The new Agent also gets a structured note about the handoff (source Agent, optional reason) on its first inbound after the transfer.',
      inputSchema: z.object({
        channelId: z.string().describe('Channel to transfer. Optional when called from a channel-driven turn; inferred from the current context (channelOriginId).').optional(),
        targetAgentSlug: z.string().describe('Slug (or UUID) of the Agent to transfer the channel to.'),
        reason: z.string().max(200).optional().describe('Optional human-readable explanation, shown in the audit trail and surfaced to the new Agent as context.'),
      }),
      execute: async ({ channelId, targetAgentSlug, reason }) => {
        // Resolve channelId (explicit > inferred from the current channel turn).
        let resolvedChannelId = channelId
        if (!resolvedChannelId && ctx.channelOriginId) {
          const origin = getChannelOriginMeta(ctx.channelOriginId)
          if (origin) resolvedChannelId = origin.channelId
        }
        if (!resolvedChannelId) {
          return { error: 'channelId could not be inferred from the current context; please pass it explicitly.' }
        }

        // Resolve the target Agent slug/UUID to a UUID; the service does the
        // rest (channel + Agent row loads, mutation, audit rows, sideband hint,
        // SSE broadcast, onIdentityChange).
        const toAgentId = resolveAgentId(targetAgentSlug)
        if (!toAgentId) {
          return { error: `Agent "${targetAgentSlug}" not found (unknown slug or UUID).` }
        }

        const result = await transferChannel({
          channelId: resolvedChannelId,
          targetAgentId: toAgentId,
          reason,
          initiatedBy: 'tool',
          calledByAgentId: ctx.agentId,
        })

        if (result.ok === false) {
          return { error: result.error }
        }
        if (result.noop) {
          return { ok: true, noop: true, message: result.message }
        }
        return {
          ok: true,
          transferredAt: result.transferredAt,
          previousAgentSlug: result.previousAgentSlug,
          newAgentSlug: result.newAgentSlug,
        }
      },
    }),
}

/**
 * deactivate_channel — deactivate an active channel (stop listening).
 * Available to main agents only.
 */
export const deactivateChannelTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description: 'Deactivate an active channel to stop listening for messages.',
      inputSchema: z.object({
        channel_id: z.string(),
      }),
      execute: async ({ channel_id }) => {
        const channel = await getChannel(channel_id)
        if (!channel || channel.agentId !== ctx.agentId) {
          return { error: 'Channel not found' }
        }

        if (channel.status === 'inactive') {
          return { error: 'Channel is already inactive' }
        }

        try {
          const deactivated = await deactivateChannel(channel_id)
          if (!deactivated) return { error: 'Deactivation failed' }
          return { success: true, status: deactivated.status }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      },
    }),
}
