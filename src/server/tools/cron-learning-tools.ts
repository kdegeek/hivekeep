import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import {
  saveCronLearning,
  deleteCronLearning,
} from '@/server/services/cron-learnings'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:cron-learning')

/**
 * save_run_learning — persist a lesson learned during this cron run.
 * Available to sub-Agents only, and only when executing a cron-triggered task.
 */
export const saveRunLearningTool: ToolRegistration = {
  availability: ['sub-agent'],
  create: (ctx) =>
    tool({
      description:
        'Save a lesson learned during this cron run. This learning will be shown to future runs ' +
        'of this same cron, helping avoid repeated mistakes and refine methods. Use this when you ' +
        'discover something unexpected about the environment, a command that works differently than ' +
        'expected, a recovery strategy that succeeded, or a more efficient approach.',
      inputSchema: z.object({
        content: z
          .string()
          .describe(
            'The learning to persist. Be specific and actionable (e.g., "The API endpoint requires header X-Auth-Token, not Authorization").',
          ),
        category: z
          .enum(['error_recovery', 'optimization', 'environment', 'general'])
          .optional()
          .describe('Optional category for organization.'),
      }),
      execute: async ({ content, category }) => {
        if (!ctx.cronId) {
          return { error: 'This tool is only available during cron task runs.' }
        }
        if (!ctx.taskId) {
          return { error: 'No task context.' }
        }

        log.debug({ cronId: ctx.cronId, taskId: ctx.taskId }, 'save_run_learning invoked')

        try {
          const learning = await saveCronLearning(ctx.cronId, content, category, ctx.taskId)
          return { success: true, learningId: learning.id }
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),
}

/**
 * delete_run_learning — delete a stale or incorrect learning from this cron.
 * Available to sub-Agents only during cron task runs.
 */
export const deleteRunLearningTool: ToolRegistration = {
  availability: ['sub-agent'],
  create: (ctx) =>
    tool({
      description:
        'Delete a stale or incorrect learning from this cron. Use when you discover a previously ' +
        'saved learning is wrong or no longer applicable.',
      inputSchema: z.object({
        learning_id: z.string().describe('ID of the learning to delete.'),
      }),
      execute: async ({ learning_id }) => {
        if (!ctx.cronId) {
          return { error: 'This tool is only available during cron task runs.' }
        }

        log.debug({ cronId: ctx.cronId, learningId: learning_id }, 'delete_run_learning invoked')

        const success = await deleteCronLearning(learning_id)
        if (!success) {
          return { error: 'Learning not found.' }
        }
        return { success: true }
      },
    }),
}
