import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { createNotification } from '@/server/services/notifications'
import type { ToolRegistration } from './types'

export const notifyTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  create: (ctx) =>
    tool({
      description:
        'Send a notification to the user (bell icon + external channels if configured).',
      inputSchema: z.object({
        title: z.string().max(100),
        body: z
          .string()
          .max(500)
          .optional(),
      }),
      execute: async ({ title, body }) => {
        await createNotification({
          type: 'agent:alert',
          title,
          body,
          agentId: ctx.agentId,
          relatedType: 'agent',
        })
        return { success: true, message: 'Notification sent to user.' }
      },
    }),
}
