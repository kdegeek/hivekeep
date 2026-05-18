import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { eq, and, asc, inArray } from 'drizzle-orm'
import {
  spawnTask,
  respondToTask,
  cancelTask,
  getTask,
  listTasksFiltered,
  getTaskMessages,
  TaskNotFoundError,
  type ListTasksFilters,
} from '@/server/services/tasks'
import { resolveKinId } from '@/server/services/kin-resolver'
import { db } from '@/server/db/index'
import { messages, tasks } from '@/server/db/schema'
import { sql } from 'drizzle-orm'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:tasks')

/**
 * spawn_self — clone the current Kin with a specific mission.
 * Available to main agents and sub-kin tasks (enables router → worker pattern).
 */
export const spawnSelfTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  create: (ctx) =>
    tool({
      description:
        'Spawn a sub-Kin copy of yourself with a specific task. Your current turn ends immediately after spawning.',
      inputSchema: z.object({
        title: z.string().describe('Short label, max ~60 chars'),
        task_description: z.string(),
        mode: z
          .enum(['await', 'async'])
          .describe(
            '"await" = result triggers a new turn; "async" = informational, no new turn',
          ),
        model: z.string().optional().describe('Model ID (e.g. "claude-sonnet-4-6", "gpt-5.5"). Omit to use the parent Kin\'s default model.'),
        provider_id: z.string().optional()
          .describe('Provider slug (e.g. "openai-codex", "claude-max") or UUID — get it from list_providers or list_models (the `slug`/`providerSlug` field). Slug is preferred (stable, human-readable). Required whenever `model` is set, since the same model name can be served by several providers.'),
        allow_human_prompt: z.boolean().optional().describe('Default: true'),
        concurrency_group: z.string().optional()
          .describe('Queue name for concurrency control (e.g. "batch-issues", "api-calls"). ' +
            'Tasks in the same group are limited to concurrency_max parallel executions. ' +
            'Excess tasks are queued and auto-promoted when a slot frees.'),
        concurrency_max: z.number().int().min(1).optional()
          .describe('Max concurrent tasks in this group. Required if concurrency_group is set. Default: 1'),
        thinking: z.boolean().optional()
          .describe('Enable extended thinking/reasoning for this task. Omit to inherit from parent Kin config.'),
        tool_preset: z.enum(['code', 'research', 'ops', 'all']).optional()
          .describe('Override the auto-picked sub-Kin tool surface. Omit to default (ticket → "code", else full). "code" = file ops + project/ticket + web docs (default for ticket sub-Kins). "research" = web + history + memory. "ops" = secrets + http_request. "all" = full surface (no filtering).'),
      }),
      execute: async ({ title, task_description, mode, model, provider_id, allow_human_prompt, concurrency_group, concurrency_max, thinking, tool_preset }) => {
        log.debug({ kinId: ctx.kinId, mode, spawnType: 'self', preset: tool_preset }, 'Task spawn requested (spawn_self)')
        if (model && !provider_id) {
          throw new Error(
            'When overriding the parent Kin\'s model, you must pass provider_id too. ' +
              'Use list_models to find the right (model, providerId) pair — the same model name can be served by several providers ' +
              '(e.g. an OpenAI API key and a Codex CLI subscription), and kinbot cannot guess which one you mean.',
          )
        }
        const { taskId, queued } = await spawnTask({
          parentKinId: ctx.kinId,
          title,
          description: task_description,
          mode,
          spawnType: 'self',
          model,
          providerId: provider_id,
          allowHumanPrompt: allow_human_prompt,
          channelOriginId: ctx.channelOriginId,
          parentTaskId: ctx.taskId ?? undefined,
          depth: ctx.taskDepth ? ctx.taskDepth + 1 : undefined,
          concurrencyGroup: concurrency_group,
          concurrencyMax: concurrency_max ?? (concurrency_group ? 1 : undefined),
          thinkingConfig: thinking !== undefined ? { enabled: thinking } : undefined,
          toolPreset: tool_preset,
        })
        return { taskId, status: queued ? 'queued' : 'pending' }
      },
    }),
}

/**
 * spawn_kin — instantiate another Kin from the platform with a specific mission.
 * Available to main agents and sub-kin tasks (enables router → worker pattern).
 */
export const spawnKinTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  create: (ctx) =>
    tool({
      description:
        'Spawn another Kin as a sub-Kin for a specific task. Your current turn ends immediately after spawning.',
      inputSchema: z.object({
        kin_slug: z.string(),
        title: z.string().describe('Short label, max ~60 chars'),
        task_description: z.string(),
        mode: z
          .enum(['await', 'async'])
          .describe(
            '"await" = result triggers a new turn; "async" = informational, no new turn',
          ),
        model: z.string().optional().describe('Model ID (e.g. "claude-sonnet-4-6", "gpt-5.5"). Omit to use the spawned Kin\'s default model.'),
        provider_id: z.string().optional()
          .describe('Provider slug (e.g. "openai-codex", "claude-max") or UUID — get it from list_providers or list_models (the `slug`/`providerSlug` field). Slug is preferred (stable, human-readable). Required whenever `model` is set, since the same model name can be served by several providers.'),
        allow_human_prompt: z.boolean().optional().describe('Default: true'),
        concurrency_group: z.string().optional()
          .describe('Queue name for concurrency control (e.g. "batch-issues", "api-calls"). ' +
            'Tasks in the same group are limited to concurrency_max parallel executions. ' +
            'Excess tasks are queued and auto-promoted when a slot frees.'),
        concurrency_max: z.number().int().min(1).optional()
          .describe('Max concurrent tasks in this group. Required if concurrency_group is set. Default: 1'),
        thinking: z.boolean().optional()
          .describe('Enable extended thinking/reasoning for this task. Omit to inherit from parent Kin config.'),
        tool_preset: z.enum(['code', 'research', 'ops', 'all']).optional()
          .describe('Override the auto-picked sub-Kin tool surface. Omit to default (ticket → "code", else full). See spawn_self for preset descriptions.'),
      }),
      execute: async ({ kin_slug, title, task_description, mode, model, provider_id, allow_human_prompt, concurrency_group, concurrency_max, thinking, tool_preset }) => {
        if (model && !provider_id) {
          return {
            error:
              'When overriding the spawned Kin\'s model, you must pass provider_id too. ' +
              'Use list_models to find the right (model, providerId) pair — the same model name can be served by several providers ' +
              '(e.g. an OpenAI API key and a Codex CLI subscription), and kinbot cannot guess which one you mean.',
          }
        }
        const kinId = resolveKinId(kin_slug)
        if (!kinId) {
          return { error: `Kin not found for slug "${kin_slug}"` }
        }
        log.debug({ kinId: ctx.kinId, targetKinId: kinId, mode, spawnType: 'other', preset: tool_preset }, 'Task spawn requested (spawn_kin)')
        const { taskId, queued } = await spawnTask({
          parentKinId: ctx.kinId,
          title,
          description: task_description,
          mode,
          spawnType: 'other',
          sourceKinId: kinId,
          model,
          providerId: provider_id,
          allowHumanPrompt: allow_human_prompt,
          channelOriginId: ctx.channelOriginId,
          parentTaskId: ctx.taskId ?? undefined,
          depth: ctx.taskDepth ? ctx.taskDepth + 1 : undefined,
          concurrencyGroup: concurrency_group,
          concurrencyMax: concurrency_max ?? (concurrency_group ? 1 : undefined),
          thinkingConfig: thinking !== undefined ? { enabled: thinking } : undefined,
          toolPreset: tool_preset,
        })
        return { taskId, status: queued ? 'queued' : 'pending' }
      },
    }),
}

/**
 * respond_to_task — answer a clarification request from a sub-Kin.
 * Available to main agents only.
 */
export const respondToTaskTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Answer a clarification request from a sub-Kin. Triggers a new LLM turn on the sub-Kin.',
      inputSchema: z.object({
        task_id: z.string(),
        answer: z.string(),
      }),
      execute: async ({ task_id, answer }) => {
        const success = await respondToTask(task_id, answer)
        if (!success) {
          return { error: 'Task not found or not active' }
        }
        return { success: true }
      },
    }),
}

/**
 * cancel_task — cancel a task in progress.
 * Available to main agents only.
 */
export const cancelTaskTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description: 'Cancel a sub-Kin task that is pending or in progress.',
      inputSchema: z.object({
        task_id: z.string(),
      }),
      execute: async ({ task_id }) => {
        const success = await cancelTask(task_id, ctx.kinId)
        if (!success) {
          return { error: 'Task not found, not owned by you, or already finished' }
        }
        return { success: true }
      },
    }),
}

function parseTimestampInput(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number') return value
  const parsed = Date.parse(value)
  if (Number.isFinite(parsed)) return parsed
  const asNum = Number(value)
  return Number.isFinite(asNum) ? asNum : undefined
}

/**
 * list_tasks — list tasks related to this Kin with filters and pagination.
 * Available to main agents and sub-kin tasks.
 */
export const listTasksTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'List tasks you spawned or were assigned, with filters and pagination. ' +
        'Returns lightweight summaries (id, title, status, kind, kin slugs, timing, duration_ms). ' +
        'Use get_task_detail(id) for full task details, or get_task_messages(id, limit, offset) ' +
        'for paginated message history. Default limit is 20, max 100.',
      inputSchema: z.object({
        status: z
          .enum(['queued', 'pending', 'in_progress', 'paused', 'awaiting_human_input', 'awaiting_kin_response', 'completed', 'failed', 'cancelled', 'all'])
          .optional()
          .describe('Filter by task status. Defaults to no filter (all statuses).'),
        parent_kin_slug: z
          .string()
          .optional()
          .describe('Filter to tasks spawned by this Kin (parent).'),
        child_kin_slug: z
          .string()
          .optional()
          .describe('Filter to tasks executed by this Kin (child / source). Useful with spawn_kin.'),
        kind: z
          .enum(['spawn_self', 'spawn_kin', 'webhook', 'cron', 'all'])
          .optional()
          .describe('Filter by how the task was created.'),
        since: z
          .union([z.string(), z.number()])
          .optional()
          .describe('Only tasks created at or after this time. Accepts ISO 8601 string or Unix ms.'),
        until: z
          .union([z.string(), z.number()])
          .optional()
          .describe('Only tasks created at or before this time. Accepts ISO 8601 string or Unix ms.'),
        limit: z.number().int().min(1).max(100).default(20).describe('Page size (max 100).'),
        offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
      }),
      execute: async (args) => {
        const filters: ListTasksFilters = {
          status: args.status,
          parentKinSlug: args.parent_kin_slug,
          childKinSlug: args.child_kin_slug,
          kind: args.kind,
          since: parseTimestampInput(args.since),
          until: parseTimestampInput(args.until),
          limit: args.limit,
          offset: args.offset,
          // Scope to tasks where this Kin is either the parent (spawner) or
          // the source (executor) unless the caller explicitly targets a Kin slug.
          relatedToKinId: args.parent_kin_slug || args.child_kin_slug ? undefined : ctx.kinId,
        }

        const { tasks: rows, total } = await listTasksFiltered(filters)
        const limit = args.limit
        const offset = args.offset
        return {
          tasks: rows.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            kind: t.kind,
            parent_kin_slug: t.parentKinSlug,
            child_kin_slug: t.childKinSlug,
            depth: t.depth,
            created_at: t.createdAt,
            updated_at: t.updatedAt,
            duration_ms: t.durationMs,
          })),
          pagination: {
            total,
            offset,
            limit,
            hasMore: offset + rows.length < total,
          },
        }
      },
    }),
}

/**
 * list_active_queues — list all active concurrency groups with status.
 * Available to main agents and sub-kin tasks.
 */
export const listActiveQueuesTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  readOnly: true,
  concurrencySafe: true,
  create: (_ctx) =>
    tool({
      description:
        'List all active concurrency groups (queues) with their current status: active count, queued count, and max concurrent limit.',
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await db
          .select({
            group: tasks.concurrencyGroup,
            concurrencyMax: tasks.concurrencyMax,
            activeCount: sql<number>`count(case when ${tasks.status} in ('pending', 'in_progress', 'awaiting_human_input', 'awaiting_kin_response') then 1 end)`,
            queuedCount: sql<number>`count(case when ${tasks.status} = 'queued' then 1 end)`,
          })
          .from(tasks)
          .where(
            and(
              sql`${tasks.concurrencyGroup} is not null`,
              inArray(tasks.status, ['queued', 'pending', 'in_progress', 'awaiting_human_input', 'awaiting_kin_response']),
            ),
          )
          .groupBy(tasks.concurrencyGroup)
          .all()

        return {
          queues: rows.map((r) => ({
            group: r.group,
            active: r.activeCount,
            queued: r.queuedCount,
            max: r.concurrencyMax,
          })),
        }
      },
    }),
}

/**
 * get_task_detail — fetch full details and message history of a task.
 * Works for tasks you spawned OR tasks where you were the executing Kin.
 */
export const getTaskDetailTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'Get full details and message history of a task you spawned or were assigned.',
      inputSchema: z.object({
        task_id: z.string(),
      }),
      execute: async ({ task_id }) => {
        const task = await getTask(task_id)
        if (!task) return { error: 'Task not found' }

        // Verify the Kin has access (either parent or source)
        if (task.parentKinId !== ctx.kinId && task.sourceKinId !== ctx.kinId) {
          return { error: 'Access denied — you are not related to this task' }
        }

        // Fetch task messages
        const taskMessages = await db
          .select({
            role: messages.role,
            content: messages.content,
            sourceType: messages.sourceType,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(and(eq(messages.kinId, task.parentKinId), eq(messages.taskId, task_id)))
          .orderBy(asc(messages.createdAt))
          .all()

        return {
          task: {
            id: task.id,
            title: task.title,
            description: task.description,
            status: task.status,
            mode: task.mode,
            spawnType: task.spawnType,
            result: task.result,
            error: task.error,
            depth: task.depth,
            createdAt: task.createdAt.toISOString(),
            updatedAt: task.updatedAt.toISOString(),
          },
          messages: taskMessages.map((m) => ({
            role: m.role,
            content: m.content,
            sourceType: m.sourceType,
            createdAt: m.createdAt.toISOString(),
          })),
        }
      },
    }),
}

/**
 * get_task_messages — paginated view of a task's message history with previews.
 * Use this to inspect long-running tasks without loading every message body
 * into the calling Kin's context.
 */
export const getTaskMessagesTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'Get a paginated view of a task\'s message history with content previews. ' +
        'Useful to inspect long-running task progress without loading full bodies into context. ' +
        'Each message returns a 200-char preview, the full content length, and tool call counts.',
      inputSchema: z.object({
        task_id: z.string().describe('The task to fetch messages from.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .describe('Number of messages to return (max 50).'),
        offset: z
          .number()
          .int()
          .default(0)
          .describe('Pagination offset. Use a negative value to fetch from the end (e.g. -20 returns the last 20 messages).'),
        order: z
          .enum(['asc', 'desc'])
          .default('desc')
          .describe('asc = oldest first, desc = newest first.'),
      }),
      execute: async ({ task_id, limit, offset, order }) => {
        // Verify the calling Kin is related to the task (parent or source).
        const task = await getTask(task_id)
        if (!task) return { error: 'Task not found' }
        if (task.parentKinId !== ctx.kinId && task.sourceKinId !== ctx.kinId) {
          return { error: 'Access denied — you are not related to this task' }
        }

        try {
          const result = await getTaskMessages(task_id, limit, offset, order)
          return {
            task_id: result.taskId,
            task_title: result.taskTitle,
            task_status: result.taskStatus,
            messages: result.messages.map((m) => ({
              id: m.id,
              role: m.role,
              source_type: m.sourceType,
              created_at: m.createdAt,
              content_preview: m.contentPreview,
              content_length: m.contentLength,
              has_tool_calls: m.hasToolCalls,
              tool_call_count: m.toolCallCount,
            })),
            pagination: {
              total: result.total,
              offset,
              limit,
              hasMore: offset >= 0 ? offset + result.messages.length < result.total : false,
            },
          }
        } catch (err) {
          if (err instanceof TaskNotFoundError) return { error: 'Task not found' }
          throw err
        }
      },
    }),
}
