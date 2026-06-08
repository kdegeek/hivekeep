import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { db } from '@/server/db/index'
import { providers } from '@/server/db/schema'
import { listModelsForProvider } from '@/server/providers/index'
import { loadProviderConfig } from '@/server/services/provider-config'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:providers')

/**
 * list_providers — list all configured providers with their capabilities.
 * Does NOT expose API keys or encrypted config.
 */
export const listProvidersTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: (_ctx) =>
    tool({
      description:
        'List all configured AI providers with their capabilities. Use this to discover which providers are available before selecting models. ' +
        'When calling another tool that takes a `provider_id` (e.g. spawn_self), pass the `slug` field below — it is stable and human-readable.\n' +
        'Every configured provider is returned, including ones that are currently failing. Check `isValid`: when it is `false` the provider is configured but not working ' +
        '(usually a bad/expired API key or unreachable endpoint), and `lastError` holds the most recent failure message so you can diagnose it. ' +
        'A provider with `isValid: false` will not yield any usable models until it is fixed (re-enter the key, then re-test it).',
      inputSchema: z.object({}),
      execute: async () => {
        const allProviders = await db.select().from(providers).all()
        const result = allProviders.map((p) => {
          let capabilities: string[] = []
          try { capabilities = JSON.parse(p.capabilities) as string[] } catch { /* ignore */ }
          return {
            id: p.id,
            slug: p.slug,
            name: p.name,
            type: p.type,
            capabilities,
            isValid: p.isValid,
            lastError: p.lastError ?? null,
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
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: (_ctx) =>
    tool({
      description:
        'List all available models across all providers. Optionally filter by capability (llm, image, embedding, search, rerank). ' +
        'Each model entry includes `providerId` (UUID), `providerSlug` (human-readable, stable, preferred for tool calls like spawn_self), ' +
        'and `providerName` (display name). When calling spawn_self/spawn_agent or any other tool needing a `provider_id`, pass the `providerSlug`.\n' +
        'Providers that are currently failing (bad/expired key, unreachable endpoint) contribute no models, but they are NOT hidden: they are reported in the ' +
        '`invalidProviders` array with their `lastError` so you can explain why a model is missing and offer to fix the provider (re-enter the key, then re-test it) ' +
        'instead of assuming nothing is configured.',
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
        const invalidProviders: Array<{
          id: string
          slug: string
          name: string
          type: string
          lastError: string | null
        }> = []

        for (const p of allProviders) {
          if (!p.isValid) {
            // Surface (don't silently drop) broken providers so the caller can
            // diagnose a bad key instead of assuming nothing is configured.
            invalidProviders.push({
              id: p.id,
              slug: p.slug,
              name: p.name,
              type: p.type,
              lastError: p.lastError ?? null,
            })
            continue
          }
          try {
            const providerConfig = await loadProviderConfig(p)
            const caps = JSON.parse(p.capabilities) as string[]
            // If the tool caller asked for a specific capability, only
            // hit that family's registry; otherwise iterate every
            // family this row declared.
            const families = capability
              ? caps.includes(capability) ? [capability] : []
              : caps.filter((f) => f === 'llm' || f === 'embedding' || f === 'image')
            for (const family of families) {
              const providerModels = await listModelsForProvider(
                p.type,
                providerConfig,
                family as 'llm' | 'embedding' | 'image',
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
            }
          } catch (err) {
            log.error({ providerId: p.id, err }, 'Failed to list models for provider')
          }
        }

        if (models.length === 0) {
          const invalidHint = invalidProviders.length > 0
            ? ` ${invalidProviders.length} configured provider(s) are currently failing (see invalidProviders for the error) — they likely have a bad/expired key; offer to re-enter the key and re-test.`
            : ''
          return {
            models: [],
            invalidProviders,
            note: capability
              ? `No models with capability '${capability}' found. Check provider configuration.${invalidHint}`
              : `No models found. Check provider configuration.${invalidHint}`,
          }
        }

        return { models, invalidProviders }
      },
    }),
}
