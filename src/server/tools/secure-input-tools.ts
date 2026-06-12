/**
 * Secure-input tools — let the configurator Agent (Queenie) request a secret from
 * the user through a UI popup. The raw value goes straight to the vault / into
 * an encrypted provider config; the LLM only ever receives a non-sensitive
 * confirmation. See services/secret-prompts.ts and queenie.md §7.
 *
 * Admin-only (these create global resources / store global secrets).
 */

import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { or, eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { agents } from '@/server/db/schema'
import {
  getConfigSchemaForType,
  getSecretFieldKeys,
  getCapabilitiesForType,
} from '@/server/providers/index'
import { channelAdapters } from '@/server/channels/index'
import { createSecretPrompt } from '@/server/services/secret-prompts'
import { requireAdmin } from '@/server/tools/config-tools'
import { PROVIDER_API_KEY_URLS } from '@/shared/constants'
import type { SecretPromptField } from '@/shared/types'
import type { ToolRegistration } from '@/server/tools/types'

/**
 * request_provider_setup — open a secure popup so the user pastes the API key
 * for a new provider. On submit the server creates + tests the provider with
 * the secret moved into the vault; the key never reaches the LLM.
 */
export const requestProviderSetupTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Open a SECURE POPUP for the user to paste the API key of a NEW provider, then configure + test it automatically. ' +
        'The key goes straight into the encrypted vault — you never see it; you get back only whether it worked. ' +
        'Call describe_provider_config first to learn the type. Pass non-secret fields (e.g. baseUrl) in `config`; the popup asks only for the secret field(s). ' +
        'This ends your turn; you resume when the user submits.',
      inputSchema: z.object({
        type: z.string().describe('Provider type, e.g. "openai", "gemini", "brave-search".'),
        name: z.string().describe('Display name for the provider, e.g. "OpenAI" or "My Gemini".'),
        families: z
          .array(z.enum(['llm', 'embedding', 'image', 'search', 'tts', 'stt']))
          .optional()
          .describe('Subset of capabilities to enable. Omit to enable everything the type supports.'),
        config: z
          .record(z.string(), z.string())
          .optional()
          .describe('Non-secret config fields (e.g. { baseUrl }). Do NOT put the API key here — the popup collects it.'),
      }),
      execute: async ({ type, name, families, config }) => {
        const denied = await requireAdmin(ctx)
        if (denied) return denied

        const caps = getCapabilitiesForType(type)
        if (caps.length === 0) {
          return { error: `Unknown provider type "${type}". Use list_provider_types to see valid types.` }
        }
        const secretKeys = getSecretFieldKeys(type)
        if (secretKeys.length === 0) {
          return { error: `Provider type "${type}" has no API-key field (it may use a different auth flow). Nothing to prompt.` }
        }
        const schema = getConfigSchemaForType(type)
        const keyUrl = PROVIDER_API_KEY_URLS[type]
        const fields: SecretPromptField[] = schema
          .filter((f) => f.type === 'secret')
          .map((f) => ({
            key: f.key,
            label: f.label,
            secret: true,
            ...(f.placeholder ? { placeholder: f.placeholder } : {}),
            ...(f.description ? { description: f.description } : {}),
            ...(keyUrl ? { keyUrl } : {}),
          }))

        const { promptId } = await createSecretPrompt({
          agentId: ctx.agentId,
          taskId: ctx.taskId,
          purpose: 'provider',
          title: `Connect ${name}`,
          description: `Paste your ${name} credentials. They go straight into the encrypted vault — I never see them.`,
          fields,
          spec: { type, name, families, config: config ?? {} },
        })

        return {
          status: 'pending',
          promptId,
          message:
            'A secure popup is open for the user to paste the credential. Your turn ends now; you will be resumed with the result (valid / invalid) once they submit. Do not ask for the key in chat.',
        }
      },
    }),
}

/**
 * request_channel_setup — open a secure popup for the user to paste a messaging
 * channel's credentials (Discord/Telegram bot token), then create + activate the
 * channel bound to an Agent. The token goes straight to the vault.
 */
export const requestChannelSetupTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Open a SECURE POPUP for the user to paste a messaging channel\'s credentials (e.g. a Discord or Telegram bot token), then create + activate the channel bound to an Agent. ' +
        'The token goes straight to the encrypted vault — you never see it; you get back whether activation succeeded. ' +
        'Ask the user which platform and which Agent first. This ends your turn; you resume when they submit.',
      inputSchema: z.object({
        platform: z.string().describe('Channel platform, e.g. "discord" or "telegram".'),
        name: z.string().describe('A name for this channel, e.g. "My Discord".'),
        agent_id: z.string().describe('Id or slug of the Agent this channel should talk to.'),
        config: z
          .record(z.string(), z.string())
          .optional()
          .describe('Non-secret config fields declared by the platform. Do NOT put the token here — the popup collects it.'),
      }),
      execute: async ({ platform, name, agent_id, config }) => {
        const denied = await requireAdmin(ctx)
        if (denied) return denied
        const adapter = channelAdapters.get(platform)
        if (!adapter) {
          return { error: `Unknown channel platform "${platform}". Supported: ${channelAdapters.list().join(', ') || 'none'}.` }
        }
        const agent = db.select().from(agents).where(or(eq(agents.id, agent_id), eq(agents.slug, agent_id))).get()
        if (!agent) return { error: `Agent not found: "${agent_id}".` }

        const fields: SecretPromptField[] = (adapter.configSchema?.fields ?? [])
          .filter((f: { type: string }) => f.type === 'password')
          .map((f: { name: string; label: string; description?: string; placeholder?: string }) => ({
            key: f.name,
            label: f.label,
            secret: true,
            ...(f.placeholder ? { placeholder: f.placeholder } : {}),
            ...(f.description ? { description: f.description } : {}),
          }))
        if (fields.length === 0) {
          return { error: `Platform "${platform}" has no secret field to prompt for.` }
        }

        const { promptId } = await createSecretPrompt({
          agentId: ctx.agentId,
          taskId: ctx.taskId,
          purpose: 'channel',
          title: `Connect ${name} (${platform})`,
          description: `Paste the ${platform} credentials. They go straight into the encrypted vault — I never see them.`,
          fields,
          spec: { platform, name, agentId: agent.id, config: config ?? {} },
        })

        return {
          status: 'pending',
          promptId,
          message:
            'A secure popup is open for the user to paste the channel credentials. Your turn ends now; you resume with the activation result once they submit.',
        }
      },
    }),
}

/**
 * prompt_secret — open a secure popup to store an arbitrary secret in the vault
 * by key (e.g. a token a custom tool will need). The value never reaches the LLM.
 */
export const promptSecretTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Open a SECURE POPUP for the user to enter a secret (token, password, key) that is stored in the vault under `key`. ' +
        'Use this for credentials that are not an AI-provider key (for those use request_provider_setup). The value goes straight to the vault — you never see it. ' +
        'This ends your turn; you resume when the user submits.',
      inputSchema: z.object({
        key: z.string().describe('SCREAMING_SNAKE_CASE vault key to store the secret under, e.g. "GITHUB_TOKEN".'),
        label: z.string().describe('Human-readable label shown in the popup, e.g. "GitHub personal access token".'),
        description: z.string().optional().describe('Optional instructions shown under the field.'),
      }),
      execute: async ({ key, label, description }) => {
        const denied = await requireAdmin(ctx)
        if (denied) return denied

        const fields: SecretPromptField[] = [
          { key, label, secret: true, ...(description ? { description } : {}) },
        ]
        const { promptId } = await createSecretPrompt({
          agentId: ctx.agentId,
          taskId: ctx.taskId,
          purpose: 'vault',
          title: label,
          description,
          fields,
          spec: { key },
        })

        return {
          status: 'pending',
          promptId,
          message: 'A secure popup is open for the user to enter the secret. Your turn ends now; you resume once they submit.',
        }
      },
    }),
}
