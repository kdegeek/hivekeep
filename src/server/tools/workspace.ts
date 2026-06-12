/**
 * Workspace resolution for native tools.
 *
 * Today's default: each Agent has a static workspace at
 *   `<config.workspace.baseDir>/<agentId>/`
 *
 * Sub-tickets 3/4 layer a per-task override on top: when a sub-task runs
 * against a ticket whose project has a ready GitHub clone, the engine
 * creates a worktree (see `worktree.ts:createWorktree`) and stashes the
 * path on `ctx.workspaceOverride.path`. Filesystem + shell tools route
 * through these helpers so the override transparently scopes them to
 * the worktree without each tool having to know about it.
 *
 * `HIVEKEEP_GH_TOKEN` rides on `ctx.workspaceOverride.env` so the shell
 * tool can merge it into the env of any subprocess it spawns — the git
 * credential helper (in the parent clone's `.git/config`) reads the PAT
 * from there. The token never lands in a tool argument or log line.
 */

import { resolve } from 'node:path'
import { config } from '@/server/config'
import type { ToolExecutionContext } from '@/server/tools/types'

/** Absolute path tools should treat as the cwd / workspace root. */
export function resolveToolWorkspace(ctx: ToolExecutionContext): string {
  if (ctx.workspaceOverride?.path) return ctx.workspaceOverride.path
  return resolve(config.workspace.baseDir, ctx.agentId)
}

/**
 * Merge any per-task env additions on top of the caller's base env.
 * Callers usually pass `{ ...process.env, HIVEKEEP_WORKSPACE: ..., ... }`
 * and rely on this helper to splice in `HIVEKEEP_GH_TOKEN` when the
 * sub-task runs inside a worktree.
 */
export function resolveToolEnv(
  ctx: ToolExecutionContext,
  base: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (!ctx.workspaceOverride?.env) return base
  return { ...base, ...ctx.workspaceOverride.env }
}
