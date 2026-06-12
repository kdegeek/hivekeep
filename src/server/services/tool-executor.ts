import type { Tool, JSONValue } from '@/server/tools/tool-helper'
import { toolRegistry } from '@/server/tools/index'
import { getCustomTool } from '@/server/services/custom-tools'
import { sseManager } from '@/server/sse/index'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import { HIVEKEEP_MAX_TOOL_USE_CONCURRENCY_DEFAULT } from '@/shared/constants'

const log = createLogger('tool-executor')

export interface ToolCall {
  id: string
  name: string
  args: unknown
  offset: number
}

export interface ToolResultEntry {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: { type: 'json'; value: JSONValue }
}

export interface ToolLogEntry {
  id: string
  name: string
  args: unknown
  result: unknown
  offset: number
}

export interface ExecuteToolBatchOptions {
  stepToolCalls: ToolCall[]
  tools: Record<string, Tool<any, any>>
  abortController: AbortController
  agentId: string
  assistantMessageId: string
  /** Extra fields merged into SSE event data (e.g. sessionId, taskId) */
  sseExtra?: Record<string, unknown>
}

export interface ExecuteToolBatchResult {
  toolResults: ToolResultEntry[]
  toolCallsLog: ToolLogEntry[]
  wasAborted: boolean
}

/** A run of tool calls scheduled together. Concurrency-safe batches run
 *  in parallel up to the configured cap; non-safe batches run serially. */
interface ToolBatch {
  isConcurrencySafe: boolean
  calls: ToolCall[]
}

/**
 * Partition a step's tool calls into batches based on each tool's
 * concurrencySafe flag.
 *
 * Algorithm (mirrors Claude Code's partitionToolCalls in
 * services/tools/toolOrchestration.ts):
 *
 *   - Walk the calls in order.
 *   - If the call's tool is concurrency-safe AND the previous batch is
 *     also concurrency-safe, fuse it into that batch.
 *   - Otherwise start a new batch (safe or unsafe).
 *
 * Unknown tools or tools that do not declare concurrencySafe stay at the
 * conservative default and land in their own isolated serial batch.
 */
export function partitionToolCalls(calls: ToolCall[]): ToolBatch[] {
  return calls.reduce<ToolBatch[]>((acc, call) => {
    const safe = toolRegistry.isConcurrencySafe(call.name)
    const last = acc[acc.length - 1]
    if (safe && last?.isConcurrencySafe) {
      last.calls.push(call)
    } else {
      acc.push({ isConcurrencySafe: safe, calls: [call] })
    }
    return acc
  }, [])
}

/**
 * Execute a step's tool calls, partitioning them into concurrency-safe
 * batches and unsafe (isolated, serial) batches.
 *
 * Within a concurrency-safe batch, calls run in parallel bounded by
 * HIVEKEEP_MAX_TOOL_USE_CONCURRENCY. Unsafe batches run their single call
 * serially. Results are always returned in the original request order.
 */
export async function executeToolBatch(opts: ExecuteToolBatchOptions): Promise<ExecuteToolBatchResult> {
  const { stepToolCalls, tools, abortController, agentId, assistantMessageId, sseExtra } = opts
  const toolCallsLog: ToolLogEntry[] = []
  const toolResults: ToolResultEntry[] = []
  const concurrencyCap = config.tools?.concurrencyCap ?? HIVEKEEP_MAX_TOOL_USE_CONCURRENCY_DEFAULT

  const batches = partitionToolCalls(stepToolCalls)
  const resultMap = new Map<string, unknown>()

  for (const batch of batches) {
    if (abortController.signal.aborted) break

    log.debug(
      {
        agentId,
        batchSize: batch.calls.length,
        isConcurrencySafe: batch.isConcurrencySafe,
        toolNames: batch.calls.map(c => c.name),
        cap: concurrencyCap,
      },
      'Executing tool batch',
    )

    if (batch.isConcurrencySafe && batch.calls.length > 1) {
      await boundedAll(
        batch.calls.map(tc => async () => {
          if (abortController.signal.aborted) return
          const result = await executeSingleTool(tc, tools, abortController)
          resultMap.set(tc.id, result)

          sseManager.sendToAgent(agentId, {
            type: 'chat:tool-result',
            agentId,
            data: { messageId: assistantMessageId, toolCallId: tc.id, toolName: tc.name, result, ...sseExtra },
          })
        }),
        concurrencyCap,
      )
    } else {
      for (const tc of batch.calls) {
        if (abortController.signal.aborted) break

        const result = await executeSingleTool(tc, tools, abortController)
        resultMap.set(tc.id, result)

        sseManager.sendToAgent(agentId, {
          type: 'chat:tool-result',
          agentId,
          data: { messageId: assistantMessageId, toolCallId: tc.id, toolName: tc.name, result, ...sseExtra },
        })
      }
    }
  }

  // Assemble results in original request order. If aborted, fill missing
  // entries with an abort placeholder so each assistant tool-call has a
  // matching tool-result (prevents tool/assistant length mismatches in
  // the next LLM turn).
  for (const tc of stepToolCalls) {
    const stored = resultMap.get(tc.id)
    if (stored === undefined) {
      if (!abortController.signal.aborted) continue
      const placeholder = { error: 'Tool execution was aborted' }
      toolCallsLog.push({ id: tc.id, name: tc.name, args: tc.args, result: placeholder, offset: tc.offset })
      toolResults.push({ type: 'tool-result', toolCallId: tc.id, toolName: tc.name, output: { type: 'json', value: placeholder as JSONValue } })
      continue
    }
    toolCallsLog.push({ id: tc.id, name: tc.name, args: tc.args, result: stored, offset: tc.offset })
    toolResults.push({ type: 'tool-result', toolCallId: tc.id, toolName: tc.name, output: { type: 'json', value: stored as JSONValue } })
  }

  return { toolResults, toolCallsLog, wasAborted: abortController.signal.aborted }
}

/**
 * Classify a tool name that is NOT present in the current (already-resolved,
 * granted-only) toolset and produce a CLEAR, ACTIONABLE message for the Agent/LLM.
 *
 * The message distinguishes the four cases that the old "has no execute
 * function" text conflated: not-granted, doesn't-exist, disabled, and the
 * genuine misconfiguration. Stays synchronous: `getCustomTool` is a sync DB
 * `.get()` and is wrapped in try/catch so a DB hiccup degrades to a generic
 * message instead of throwing inside tool execution.
 */
export function describeUnavailableTool(name: string): string {
  const existsButNotGranted = `Tool "${name}" exists but is not in your current toolset. It must be granted by one of your active toolboxes — ask the user to add it to a toolbox (or pick a toolbox that includes it). Only call tools provided in your context.`
  const unknown = `No tool named "${name}" exists. Use only the tools provided in your context — do not invent tool names.`

  // Custom tools: `custom_<slug>`.
  if (name.startsWith('custom_')) {
    const slug = name.slice('custom_'.length)
    try {
      const row = getCustomTool(slug)
      if (row && row.enabled === false) {
        return `Custom tool "${name}" exists but is currently disabled, so it can't be called. Re-enable it in Settings → Custom Tools (or ask the user to).`
      }
      if (row) {
        return existsButNotGranted
      }
      return unknown
    } catch {
      // DB hiccup — degrade gracefully rather than throwing mid-execution.
      return unknown
    }
  }

  // MCP tools: `mcp_<server>_<tool>`.
  if (name.startsWith('mcp_')) {
    return `MCP tool "${name}" is not in your current toolset. It must be granted by one of your active toolboxes, and its MCP server must be active.`
  }

  // Native / plugin tools live in the in-memory registry.
  if (toolRegistry.getDomain(name) !== null) {
    return existsButNotGranted
  }

  return unknown
}

export async function executeSingleTool(
  tc: ToolCall,
  tools: Record<string, Tool<any, any>>,
  abortController: AbortController,
): Promise<unknown> {
  const toolDef = tools[tc.name]
  if (!toolDef) {
    return { error: describeUnavailableTool(tc.name) }
  }
  if (!('execute' in toolDef) || typeof toolDef.execute !== 'function') {
    return { error: `Tool "${tc.name}" is misconfigured (no execute function) — this is an internal bug, not a mistake on your part.` }
  }
  if (abortController.signal.aborted) {
    return { error: 'Tool execution was aborted' }
  }

  const execPromise = (async () => {
    try {
      return await (toolDef.execute as Function)(tc.args, { abortSignal: abortController.signal })
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })()

  // Race the tool against the abort signal so that a tool which doesn't honour
  // `abortSignal` (or is genuinely stuck) can't keep the turn from unwinding
  // when the user clicks Stop. The abandoned tool promise is allowed to settle
  // in the background (its result discarded); tools like run_shell additionally
  // kill their child process on abort so no work is left running.
  let onAbort: (() => void) | undefined
  const abortPromise = new Promise<unknown>((resolve) => {
    onAbort = () => resolve({ error: 'Tool execution was aborted' })
    abortController.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([execPromise, abortPromise])
  } finally {
    if (onAbort) abortController.signal.removeEventListener('abort', onAbort)
    execPromise.catch(() => {}) // swallow late rejection from the abandoned tool
  }
}

/**
 * Run async tasks with bounded concurrency.
 * Inspired by Claude Code's `all()` generator but simplified for Promise-based tasks.
 */
async function boundedAll(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  const executing = new Set<Promise<void>>()

  for (const task of tasks) {
    const p = task().then(() => { executing.delete(p) })
    executing.add(p)
    if (executing.size >= limit) {
      await Promise.race(executing)
    }
  }

  await Promise.all(executing)
}
