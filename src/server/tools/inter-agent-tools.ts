import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import {
  sendInterAgentMessage,
  replyToInterAgentMessage,
  listAvailableAgents,
} from '@/server/services/inter-agent'
import { resolveAgentId } from '@/server/services/agent-resolver'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:inter-agent')

/**
 * send_message — send a message to another Agent on the platform.
 * Available to main agents only.
 */
export const sendMessageTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Send a message to another Agent. Use "request" for responses, "inform" for one-way notifications.',
      inputSchema: z.object({
        slug: z.string(),
        message: z.string(),
        type: z
          .enum(['request', 'inform'])
          .describe('"request" = expect response; "inform" = no LLM turn triggered'),
      }),
      execute: async ({ slug, message, type }) => {
        log.debug({ agentId: ctx.agentId, targetSlug: slug, type }, 'Inter-agent message send requested')
        try {
          const targetAgentId = resolveAgentId(slug)
          if (!targetAgentId) return { error: `Agent "${slug}" not found` }

          const result = await sendInterAgentMessage({
            senderAgentId: ctx.agentId,
            targetAgentId,
            message,
            type,
            channelOriginId: ctx.channelOriginId,
          })

          // Sub-Agent context with request type: suspend task and wait for reply
          if (ctx.taskId && type === 'request' && result.requestId) {
            const { suspendTaskForAgentResponse } = await import('@/server/services/tasks')
            const suspendResult = await suspendTaskForAgentResponse(ctx.taskId, result.requestId)
            if (!suspendResult.success) {
              return { error: suspendResult.error }
            }
            return {
              success: true,
              requestId: result.requestId,
              note: `Your task is now paused waiting for a response from "${slug}". You will receive the response when the task resumes.`,
            }
          }

          return { success: true, requestId: result.requestId }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      },
    }),
}

/**
 * reply — reply to a request from another Agent.
 * Replies are ALWAYS of type "inform" to prevent ping-pong loops.
 * Available to main agents only.
 */
export const replyTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Reply to a request from another Agent. Replies are always informational (no ping-pong).',
      inputSchema: z.object({
        request_id: z.string(),
        message: z.string(),
      }),
      execute: async ({ request_id, message }) => {
        try {
          await replyToInterAgentMessage({
            senderAgentId: ctx.agentId,
            requestId: request_id,
            message,
          })
          return { success: true }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      },
    }),
}

/**
 * list_kins — discover available Agents on the platform.
 * Available to main agents only.
 */
export const listAgentsTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description: 'List all available Agents on the platform.',
      inputSchema: z.object({}),
      execute: async () => {
        const availableAgents = await listAvailableAgents(ctx.agentId)
        return {
          agents: availableAgents.map((k) => ({
            slug: k.slug,
            name: k.name,
            role: k.role,
          })),
        }
      },
    }),
}
