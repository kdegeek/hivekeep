/**
 * Unified tool-grant resolver.
 *
 * The TOOLBOX is the sole tool-grant primitive for main Kins AND tasks, across
 * all four tool sources: native, plugin, MCP, and custom. There is no per-Kin
 * gate and no capability flags.
 *
 * Resolution model
 * ----------------
 *   universe = native + plugin            (toolRegistry.resolve — both)
 *            + ALL global active MCP tools (resolveMCPTools — no per-Kin gate)
 *            + the Kin's custom tools      (resolveCustomTools)
 *
 *   allowed  = CORE_TOOLS ∪ resolveToolboxNames(toolboxIds)
 *              where a null/empty toolbox selection resolves to the 'all'
 *              built-in (by NAME, at runtime — never a SQL backfill).
 *
 *   toolset  = { name ∈ universe | name ∈ allowed }
 *
 * "*" inside a toolbox (the 'all' built-in) expands to all NATIVE tool names
 * only — MCP and custom tools must be listed by their stable name to be
 * granted. A toolbox-listed name that is absent from the universe is silently
 * skipped.
 *
 * For sub-Kins the HARD_EXCLUDED_FROM_SUBKIN floor is subtracted AFTER the
 * allow-list, so even an 'all' toolbox can't smuggle a main-session-only tool
 * into a task. (`spawn_self` / `spawn_kin` are intentionally NOT excluded.)
 *
 * This is the single tool-resolution path for every surface (main Kins, quick
 * sessions, and tasks). The toolbox is the sole tool-grant primitive — there is
 * no per-Kin tool config, no MCP access gate, and no network flag.
 */

import type { Tool } from '@/server/tools/tool-helper'
import { toolRegistry } from '@/server/tools/index'
import { resolveMCPTools } from '@/server/services/mcp'
import { resolveCustomTools } from '@/server/services/custom-tools'
import { CORE_TOOLS, getToolboxByName, resolveToolboxNames } from '@/server/services/toolboxes'
import { HARD_EXCLUDED_FROM_SUBKIN } from '@/server/services/tasks'
import { createLogger } from '@/server/logger'

const log = createLogger('toolset-resolver')

/**
 * Resolve a raw `kins.toolbox_ids` / `tasks.toolbox_ids` selection into a clean
 * array of toolbox **ids**.
 *
 * A null / empty / malformed selection resolves to the 'all' built-in (by name,
 * at runtime — seeding runs at app boot, after migrations, so the row exists).
 * Ticket tasks could differ here, but for the unified resolver the default is
 * always 'all'; task-specific defaults remain in `resolveTaskToolboxIds`.
 *
 * Mirrors `resolveTaskToolboxIds` in tasks.ts (explicit ids → default by name),
 * minus the legacy `tool_preset` back-compat which only applies to tasks.
 */
export function resolveKinToolboxIds(
  raw: string[] | string | null | undefined,
  _opts?: { ticketId?: string | null },
): string[] {
  let ids: string[] = []

  if (Array.isArray(raw)) {
    ids = raw.filter((x): x is string => typeof x === 'string')
  } else if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        ids = parsed.filter((x): x is string => typeof x === 'string')
      }
    } catch {
      // Malformed — treat as absent.
    }
  }

  if (ids.length > 0) return ids

  // Default: the 'all' built-in, resolved by name at runtime.
  const box = getToolboxByName('all')
  return box ? [box.id] : []
}

export interface ResolveToolsetOptions {
  kinId: string
  /** Raw toolbox selection from the Kin or task row (JSON string, array, or
   *  null). Null / empty → the 'all' built-in. */
  toolboxIds: string[] | string | null | undefined
  isSubKin: boolean
  taskId?: string
  taskDepth?: number
  ticketId?: string
  channelOriginId?: string
  cronId?: string
  userId?: string
  workspaceOverride?: {
    path: string
    env?: Record<string, string>
  }
  /** Reserved for quick-session callers (Stage 3 applies
   *  QUICK_SESSION_EXCLUDED_TOOLS at the call site, not here). */
  quick?: boolean
}

/**
 * Resolve the final toolset (Record<name, Tool>) for a Kin or task from its
 * toolbox selection, unifying native + plugin + MCP + custom under one
 * allow-list. See the module header for the exact model.
 */
export async function resolveToolset(
  opts: ResolveToolsetOptions,
): Promise<Record<string, Tool<any, any>>> {
  const {
    kinId,
    toolboxIds,
    isSubKin,
    taskId,
    taskDepth,
    ticketId,
    channelOriginId,
    cronId,
    userId,
    workspaceOverride,
  } = opts

  // ── Universe ──────────────────────────────────────────────────────────────
  // native + plugin (both from the tool registry).
  const registryTools = toolRegistry.resolve({
    kinId,
    userId,
    isSubKin,
    taskId,
    taskDepth,
    channelOriginId,
    cronId,
    ticketId,
    workspaceOverride,
  })

  // ALL global active MCP tools (no per-Kin gate) + the Kin's custom tools.
  const mcpTools = await resolveMCPTools(kinId)
  const customTools = await resolveCustomTools(kinId)

  const universe: Record<string, Tool<any, any>> = {
    ...registryTools,
    ...mcpTools,
    ...customTools,
  }

  // ── Allow-list ──────────────────────────────────────────────────────────────
  // CORE_TOOLS ∪ (the toolboxes' listed names). "*" → all native only.
  const resolvedIds = resolveKinToolboxIds(toolboxIds, { ticketId: ticketId ?? null })
  const allowed = new Set<string>([...CORE_TOOLS, ...resolveToolboxNames(resolvedIds)])

  // ── Filter universe → toolset ─────────────────────────────────────────────────
  const toolset: Record<string, Tool<any, any>> = {}
  for (const [name, tool] of Object.entries(universe)) {
    if (allowed.has(name)) toolset[name] = tool
  }

  // ── Sub-Kin hard floor ──────────────────────────────────────────────────────
  if (isSubKin) {
    for (const name of HARD_EXCLUDED_FROM_SUBKIN) {
      delete toolset[name]
    }
  }

  log.debug(
    {
      kinId,
      taskId,
      isSubKin,
      toolboxIds: resolvedIds,
      universeCount: Object.keys(universe).length,
      toolsetCount: Object.keys(toolset).length,
      mcpCount: Object.keys(mcpTools).length,
      customCount: Object.keys(customTools).length,
    },
    'Unified toolset resolved',
  )

  return toolset
}
