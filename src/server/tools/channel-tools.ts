import { tool } from 'ai'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import {
  listChannels,
  getChannel,
  listChannelConversations,
  createChannel,
  updateChannel,
  deleteChannel,
  activateChannel,
  deactivateChannel,
  setChannelTransferHint,
  getChannelOriginMeta,
} from '@/server/services/channels'
import { db } from '@/server/db/index'
import { channels, kins, messages } from '@/server/db/schema'
import { resolveKinId } from '@/server/services/kin-resolver'
import { channelAdapters } from '@/server/channels/index'
import { sseManager } from '@/server/sse/index'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'
import type { OutboundAttachment } from '@/server/channels/adapter'
import type { ChannelPlatform } from '@/shared/types'

const log = createLogger('tools:channel')

/**
 * list_channels — list all messaging channels connected to this Kin.
 * Available to main agents only.
 */
export const listChannelsTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  create: (ctx) =>
    tool({
      description: 'List all messaging channels connected to this Kin.',
      inputSchema: z.object({}),
      execute: async () => {
        const items = await listChannels(ctx.kinId)
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
 * Useful for proactive messaging: the Kin needs a chat_id to send messages.
 */
export const listChannelConversationsTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  create: (ctx) =>
    tool({
      description:
        'List known users and chat IDs for a channel. Use to discover who you can message proactively.',
      inputSchema: z.object({
        channel_id: z.string(),
      }),
      execute: async ({ channel_id }) => {
        const channel = await getChannel(channel_id)
        if (!channel || channel.kinId !== ctx.kinId) {
          return { error: 'Channel not found' }
        }
        return await listChannelConversations(channel_id)
      },
    }),
}

/**
 * send_channel_message — proactively send a message to an external platform.
 * Opt-in tool (defaultDisabled). Available to main agents only.
 */
export const sendChannelMessageTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Send a message to an external platform via a connected channel.',
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
        log.debug({ kinId: ctx.kinId, channelId: channel_id, chatId: chat_id }, 'Channel message send requested')

        // Verify ownership
        const channel = await getChannel(channel_id)
        if (!channel || channel.kinId !== ctx.kinId) {
          return { error: 'Channel not found' }
        }

        if (channel.status !== 'active') {
          return { error: 'Channel is not active' }
        }

        const adapter = channelAdapters.get(channel.platform)
        if (!adapter) {
          return { error: `No adapter for platform ${channel.platform}` }
        }

        try {
          const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
          const outboundAttachments: OutboundAttachment[] | undefined = attachments?.map(a => ({
            source: a.source,
            mimeType: a.mimeType,
            fileName: a.fileName,
          }))
          const result = await adapter.sendMessage(channel_id, cfg, {
            chatId: chat_id,
            content: message,
            attachments: outboundAttachments?.length ? outboundAttachments : undefined,
          })
          return { success: true, platformMessageId: result.platformMessageId }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      },
    }),
}

/**
 * create_channel — create a new messaging channel for this Kin.
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
        log.debug({ kinId: ctx.kinId, platform, name, configKeys: Object.keys(config) }, 'Channel creation requested')

        if (!channelAdapters.get(platform)) {
          return { error: `Unknown platform "${platform}". Available: ${channelAdapters.list().join(', ')}` }
        }

        try {
          const channel = await createChannel({
            kinId: ctx.kinId,
            name,
            platform: platform as ChannelPlatform,
            platformConfig: config,
            allowedChatIds: allowed_chat_ids,
            autoCreateContacts: auto_create_contacts,
            createdBy: 'kin',
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
        if (!channel || channel.kinId !== ctx.kinId) {
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
  create: (ctx) =>
    tool({
      description:
        'Permanently delete a messaging channel. Only use when explicitly asked.',
      inputSchema: z.object({
        channel_id: z.string(),
      }),
      execute: async ({ channel_id }) => {
        const channel = await getChannel(channel_id)
        if (!channel || channel.kinId !== ctx.kinId) {
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
        if (!channel || channel.kinId !== ctx.kinId) {
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
 * transfer_channel — re-bind a channel to a different Kin at runtime.
 *
 * Any Kin can call this (no "channel owner" restriction). Effects:
 *   - channels.kinId is mutated to the target Kin.
 *   - Two role='system' audit-trail messages are inserted, one per Kin, with
 *     metadata.systemEvent='channel_transferred_out' / 'channel_transferred_in'.
 *     buildMessageHistory filters these out of the LLM prompt; the UI renders
 *     them as a handoff banner.
 *   - A one-shot channelTransferHint is stashed in the sideband. The next
 *     inbound on the channel pops it and surfaces the handoff via
 *     <channel-context> to the new Kin on its first turn.
 *   - SSE 'channel:transferred' is broadcast so any open UI tab updates the
 *     sidebar binding badge in real time.
 *
 * No turn is triggered on the new Kin at transfer time. The new Kin discovers
 * the conversation when the user next sends a message.
 */
export const transferChannelTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Transfer a channel binding to another Kin. The target Kin will receive the next inbound message on this channel (no immediate turn is triggered). Both Kins get a visible audit-trail row in their conversation. The new Kin also gets a structured note about the handoff (source Kin, optional reason) on its first inbound after the transfer.',
      inputSchema: z.object({
        channelId: z.string().describe('Channel to transfer. Optional when called from a channel-driven turn; inferred from the current context (channelOriginId).').optional(),
        targetKinSlug: z.string().describe('Slug (or UUID) of the Kin to transfer the channel to.'),
        reason: z.string().max(200).optional().describe('Optional human-readable explanation, shown in the audit trail and surfaced to the new Kin as context.'),
      }),
      execute: async ({ channelId, targetKinSlug, reason }) => {
        // 1. Resolve channelId (explicit > inferred from current channel turn).
        let resolvedChannelId = channelId
        if (!resolvedChannelId) {
          if (ctx.channelOriginId) {
            const origin = getChannelOriginMeta(ctx.channelOriginId)
            if (origin) resolvedChannelId = origin.channelId
          }
        }
        if (!resolvedChannelId) {
          return { error: 'channelId could not be inferred from the current context; please pass it explicitly.' }
        }

        // 2. Load the channel.
        const channel = await getChannel(resolvedChannelId)
        if (!channel) {
          return { error: `Channel "${resolvedChannelId}" not found.` }
        }

        // 3. Resolve the target Kin (slug or UUID → UUID, then load the full row).
        const toKinId = resolveKinId(targetKinSlug)
        if (!toKinId) {
          return { error: `Kin "${targetKinSlug}" not found (unknown slug or UUID).` }
        }

        // 4. No-op if already bound to the target.
        if (channel.kinId === toKinId) {
          return { ok: true, noop: true, message: 'Channel is already bound to this Kin.' }
        }

        // 5. Capture both Kin rows (source for audit + sideband, target for the
        //    audit trail row and the SSE event). Two separate queries keep the
        //    mock surface in tests narrow (same dbChain.get pattern used by
        //    sibling tool tests).
        const fromKinRow = db
          .select({ id: kins.id, slug: kins.slug, name: kins.name })
          .from(kins)
          .where(eq(kins.id, channel.kinId))
          .get()
        if (!fromKinRow) {
          return { error: `Source Kin "${channel.kinId}" not found; refusing to transfer from a dangling binding.` }
        }
        const toKinRow = db
          .select({ id: kins.id, slug: kins.slug, name: kins.name })
          .from(kins)
          .where(eq(kins.id, toKinId))
          .get()
        if (!toKinRow) {
          return { error: `Target Kin "${toKinId}" not found after resolution; refusing to transfer to a dangling binding.` }
        }
        const fromKinId = fromKinRow.id
        const fromKinSlug = fromKinRow.slug ?? fromKinRow.id
        const fromKinName = fromKinRow.name
        const toKinSlug = toKinRow.slug ?? toKinRow.id
        const toKinName = toKinRow.name

        const at = Date.now()
        const now = new Date(at)

        // 6. Mutate the binding.
        await db
          .update(channels)
          .set({ kinId: toKinId, updatedAt: now })
          .where(eq(channels.id, channel.id))

        // 7. Insert two audit-trail rows, one in each Kin's history.
        //    role='system' + sourceType='system' renders as a centered banner
        //    in the chat UI. metadata.systemEvent discriminates the row type
        //    for the UI; buildMessageHistory filters both out of the LLM prompt.
        const outMetaJson = JSON.stringify({
          systemEvent: 'channel_transferred_out',
          channelId: channel.id,
          channelName: channel.name,
          targetKinId: toKinId,
          targetKinSlug: toKinSlug,
          targetKinName: toKinName,
          reason: reason ?? null,
          at,
        })
        const inMetaJson = JSON.stringify({
          systemEvent: 'channel_transferred_in',
          channelId: channel.id,
          channelName: channel.name,
          fromKinId,
          fromKinSlug,
          fromKinName,
          reason: reason ?? null,
          at,
        })
        await db.insert(messages).values({
          id: uuid(),
          kinId: fromKinId,
          role: 'system',
          content: null,
          sourceType: 'system',
          sourceId: null,
          metadata: outMetaJson,
          createdAt: now,
        })
        await db.insert(messages).values({
          id: uuid(),
          kinId: toKinId,
          role: 'system',
          content: null,
          sourceType: 'system',
          sourceId: null,
          metadata: inMetaJson,
          createdAt: now,
        })

        // 8. Stash the one-shot hint for the next inbound.
        setChannelTransferHint(channel.id, {
          fromKinId,
          fromKinSlug,
          fromKinName,
          reason,
          at,
        })

        // 9. Broadcast SSE so live UI tabs refresh the sidebar binding.
        sseManager.broadcast({
          type: 'channel:transferred',
          data: {
            channelId: channel.id,
            channelName: channel.name,
            fromKinId,
            fromKinSlug,
            fromKinName,
            toKinId,
            toKinSlug,
            toKinName,
            reason: reason ?? null,
            at,
          },
        })

        log.info(
          { calledByKinId: ctx.kinId, channelId: channel.id, fromKinId, toKinId, reason: reason ?? null },
          'Channel transferred',
        )

        return {
          ok: true,
          transferredAt: at,
          previousKinSlug: fromKinSlug,
          newKinSlug: toKinSlug,
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
        if (!channel || channel.kinId !== ctx.kinId) {
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
