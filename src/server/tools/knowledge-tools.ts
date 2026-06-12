import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { searchKnowledge, listSources } from '@/server/services/knowledge'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:knowledge')

/**
 * search_knowledge - search the Agent's knowledge base using hybrid search.
 * Available to main agents only.
 */
export const searchKnowledgeTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'Search your knowledge base (uploaded documents and texts) for relevant information.',
      inputSchema: z.object({
        query: z.string(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Default: 5'),
      }),
      execute: async ({ query, limit }) => {
        log.debug({ agentId: ctx.agentId, query }, 'search_knowledge invoked')
        const results = await searchKnowledge(ctx.agentId, query, limit)
        return {
          chunks: results.map((r) => ({
            content: r.content,
            sourceId: r.sourceId,
            position: r.position,
            score: r.score,
          })),
        }
      },
    }),
}

/**
 * list_knowledge_sources - list available knowledge sources for the Agent.
 * Available to main agents only.
 */
export const listKnowledgeSourcesTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'List all knowledge sources (documents, texts) in your knowledge base.',
      inputSchema: z.object({}),
      execute: async () => {
        log.debug({ agentId: ctx.agentId }, 'list_knowledge_sources invoked')
        const sources = await listSources(ctx.agentId)
        return {
          sources: sources.map((s) => ({
            id: s.id,
            name: s.name,
            type: s.type,
            status: s.status,
            chunkCount: s.chunkCount,
            tokenCount: s.tokenCount,
          })),
        }
      },
    }),
}
