import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { db } from '@/server/db/index'
import { providers } from '@/server/db/schema'
import { listModelsForProvider } from '@/server/providers/index'
import { decrypt } from '@/server/services/encryption'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:providers')

/**
 * list_providers — list all configured providers with their capabilities.
 * Does NOT expose API keys or encrypted config.
 */
export const listProvidersTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  readOnly: true,
  concurrencySafe: true,
  create: (_ctx) =>
    tool({
      description:
        'List all configured AI providers with their capabilities. Use this to discover which providers are available before selecting models. ' +
        'When calling another tool that takes a `provider_id` (e.g. spawn_self), pass the `slug` field below — it is stable and human-readable.',
      inputSchema: z.object({}),
      execute: async () => {
        const allProviders = await db.select().from(providers).all()
        const result = allProviders
          .filter((p) => p.isValid)
          .map((p) => {
            let capabilities: string[] = []
            try { capabilities = JSON.parse(p.capabilities) as string[] } catch { /* ignore */ }
            return {
              id: p.id,
              slug: p.slug,
              name: p.name,
              type: p.type,
              capabilities,
            }
          })

        return { providers: result }
      },
    }),
}

/**
 * list_models — list all available models, optionally filtered by capability.
 * Returns provider+model combo for each model.
 */
export const listModelsTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  readOnly: true,
  concurrencySafe: true,
  create: (_ctx) =>
    tool({
      description:
        'List all available models across all providers. Optionally filter by capability (llm, image, embedding, search, rerank). ' +
        'Each model entry includes `providerId` (UUID), `providerSlug` (human-readable, stable, preferred for tool calls like spawn_self), ' +
        'and `providerName` (display name). When calling spawn_self/spawn_kin or any other tool needing a `provider_id`, pass the `providerSlug`.',
      inputSchema: z.object({
        capability: z
          .enum(['llm', 'image', 'embedding', 'search', 'rerank'])
          .optional()
          .describe('Filter models by capability. Returns all if omitted.'),
      }),
      execute: async ({ capability }) => {
        const allProviders = await db.select().from(providers).all()
        const models: Array<{
          id: string
          name: string
          providerId: string
          providerSlug: string
          providerName: string
          providerType: string
          capability: string
        }> = []

        for (const p of allProviders) {
          if (!p.isValid) continue
          try {
            const providerConfig = JSON.parse(await decrypt(p.configEncrypted))
            const providerModels = await listModelsForProvider(
              p.type,
              providerConfig,
              p.family as 'llm' | 'embedding' | 'image',
            )

            for (const model of providerModels) {
              if (capability && model.capability !== capability) continue
              models.push({
                id: model.id,
                name: model.name,
                providerId: p.id,
                providerSlug: p.slug,
                providerName: p.name,
                providerType: p.type,
                capability: model.capability,
              })
            }
          } catch (err) {
            log.error({ providerId: p.id, err }, 'Failed to list models for provider')
          }
        }

        if (models.length === 0) {
          return {
            models: [],
            note: capability
              ? `No models with capability '${capability}' found. Check provider configuration.`
              : 'No models found. Check provider configuration.',
          }
        }

        return { models }
      },
    }),
}
