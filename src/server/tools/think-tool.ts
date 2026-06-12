import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { createLogger } from '@/server/logger'
import { recordGuardFire } from '@/server/services/tool-call-tracker'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('think-tool')

/**
 * `think` — a no-op tool that records a thought.
 *
 * Ported from Claude Code's ThinkTool, itself inspired by the tau-bench
 * paper. The tool reads nothing, writes nothing, and changes nothing in the
 * world — its only effect is that the model commits a structured thought
 * into the conversation as a tool call, which:
 *
 *   - lets the model brainstorm or plan before issuing concrete tool calls
 *     (less thrash when the next action would otherwise have been a
 *      speculative read or grep),
 *   - keeps the reasoning visible to the user and to compacting summaries,
 *   - costs the same as one tool call but produces zero side effects, so
 *     it's safe to lean on for hard problems.
 *
 * Intentionally `readOnly: true, concurrencySafe: true` — the model can
 * batch a thought with other read calls in the same step.
 */
export const thinkTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'Record a thought to help you reason about the current problem. **No side effects** — does not read, write, or call out to anything. Use it when you need to plan, brainstorm alternatives, sanity-check a hypothesis, or untangle a debugging session before committing to concrete tool calls. Common cases: after a failing test, before designing a refactor, when picking between several implementation paths, when results don\'t match your expectation. Does NOT replace `prompt_human` — use that to ask the user a real question.',
      inputSchema: z.object({
        thought: z
          .string()
          .min(1)
          .max(8000)
          .describe('Free-form reasoning. One paragraph or several — go as deep as needed.'),
      }),
      execute: async ({ thought }) => {
        log.info({ agentId: ctx.agentId, taskId: ctx.taskId, length: thought.length }, 'Thought recorded')
        recordGuardFire(ctx.taskId, 'thinkCall')
        return {
          success: true,
          thought,
        }
      },
    }),
}
