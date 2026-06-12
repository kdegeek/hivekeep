/**
 * Per-task tracker of read-style tool calls (read_file / grep).
 *
 * On real prod tasks the sub-Agent agent often re-issues the same `read_file`
 * or `grep` it just did a few steps ago — the prompt rule "don't re-read
 * what's already in your context" only catches part of it. This tracker
 * decorates the tool response with a `previousCallCount` hint when the
 * same signature repeats inside a task. It's non-blocking on purpose: the
 * model may legitimately re-read after an edit, or after a long thought,
 * but it now has a clear signal that the prior result is still upstream
 * in the conversation.
 *
 * State lives in-process; it's cleared when a task resolves (completed /
 * failed / cancelled). For non-task contexts (main Agent conversation) the
 * tracker silently no-ops, since main-Agent context is conversational and
 * the same prompt rule applies less cleanly there.
 */

import { createLogger } from '@/server/logger'

const log = createLogger('tool-call-tracker')

export type TrackedKind = 'read_file' | 'grep'

interface ReadFileRange {
  offset?: number
  limit?: number
}

interface PerTaskCounts {
  // signature → number of previous calls (0 the first time, >=1 on repeats).
  counts: Map<string, number>
  // Set of file paths the task has already read via read_file. Used by the
  // edit/multi-edit "read-before-edit" guard (ported from opencode) to
  // prevent hallucinated edits on files the sub-Agent hasn't actually seen.
  readPaths: Set<string>
  // path → list of every range the task has read for that path. Used by
  // the soft `duplicate` hint so the model sees ALL prior windows, not
  // just whether the exact (path, offset, limit) tuple was repeated.
  // Real-world failure that motivated this: prod task #e6c9d6f1 read
  // ChatPanel.tsx 11 times with overlapping offsets — no two calls
  // shared a signature so the prior tracker fired zero hints despite
  // ~30 KB of redundant tokens.
  readRanges: Map<string, ReadFileRange[]>
  // Guard-fire telemetry. Each counter records how often the runtime
  // intervened on the model's behalf during this task. Used to validate
  // whether the iterations actually changed agent behaviour vs the
  // baseline (task #32: ~25 PATH archaeology calls, ~15 redundant greps,
  // ~10 file re-reads, ~12 bash wrappers). Logged on task resolve.
  stats: TaskGuardStats
}

export interface TaskGuardStats {
  /** read_file calls that hit a duplicate signature (i.e. the soft hint fired). */
  duplicateReads: number
  /** grep calls that hit a duplicate signature. */
  duplicateGreps: number
  /** edit_file / multi_edit refused because the path wasn't read first. */
  readBeforeEditRefusals: number
  /** run_shell refused for being a thin wrapper around a dedicated tool. */
  bashWrapperRefusals: number
  /** run_shell refused for invoking a banned binary (curl, wget, lynx, …). */
  bannedCommandRefusals: number
  /** run_shell refused for trying to skip hooks (--no-verify / HUSKY=0 / …). */
  hookBypassRefusals: number
  /** `think` tool invocations (no-op reasoning slot). */
  thinkCalls: number
  /** `task_todos` bulk-set calls. */
  todoUpdates: number
}

function freshStats(): TaskGuardStats {
  return {
    duplicateReads: 0,
    duplicateGreps: 0,
    readBeforeEditRefusals: 0,
    bashWrapperRefusals: 0,
    bannedCommandRefusals: 0,
    hookBypassRefusals: 0,
    thinkCalls: 0,
    todoUpdates: 0,
  }
}

const byTask = new Map<string, PerTaskCounts>()

function bucket(taskId: string): PerTaskCounts {
  let entry = byTask.get(taskId)
  if (!entry) {
    entry = { counts: new Map(), readPaths: new Set(), readRanges: new Map(), stats: freshStats() }
    byTask.set(taskId, entry)
  }
  return entry
}

/**
 * Record a `read_file` call for a path and return every range the task has
 * already read for that same path. Strictly more useful than the generic
 * `noteCall(readFileSignature(...))` form because it captures overlap
 * regardless of offset/limit drift. The caller surfaces the previous ranges
 * to the model as a soft hint — the duplicate-reads telemetry counter is
 * also bumped here when at least one prior range exists.
 *
 * No-op (returns empty) outside a task context — same convention as the
 * other helpers in this module.
 */
export function noteReadFile(
  taskId: string | undefined,
  path: string,
  range: ReadFileRange,
): { previousRanges: ReadFileRange[] } {
  if (!taskId) return { previousRanges: [] }
  const entry = bucket(taskId)
  const prior = entry.readRanges.get(path) ?? []
  if (prior.length > 0) entry.stats.duplicateReads += 1
  // Keep the prior snapshot before pushing — the caller wants ranges read
  // *before* this call.
  const previousRanges = prior.slice()
  prior.push({ offset: range.offset, limit: range.limit })
  entry.readRanges.set(path, prior)
  return { previousRanges }
}

/**
 * Format a range as a 1-indexed line span, e.g. `850-949` or `850-end`.
 * Used in the duplicate-read hint message.
 */
export function formatReadRange(range: ReadFileRange): string {
  const start = range.offset ?? 1
  if (range.limit == null) return `${start}-end`
  return `${start}-${start + range.limit - 1}`
}

/**
 * Note a tool call. Returns the number of previous calls with the same
 * signature in this task; 0 means it's a fresh call. The caller decides
 * how to surface this to the model.
 *
 * When `taskId` is undefined (main Agent contexts), the tracker no-ops and
 * always returns 0 — see module doc.
 */
export function noteCall(
  taskId: string | undefined,
  kind: TrackedKind,
  signature: string,
): { previousCallCount: number } {
  if (!taskId) return { previousCallCount: 0 }
  const entry = bucket(taskId)
  const prev = entry.counts.get(signature) ?? 0
  entry.counts.set(signature, prev + 1)
  if (prev > 0) {
    if (kind === 'read_file') entry.stats.duplicateReads += 1
    else if (kind === 'grep') entry.stats.duplicateGreps += 1
  }
  return { previousCallCount: prev }
}

/**
 * Increment one of the guard-fire counters for a task. No-ops outside a
 * task context. Called from the tools at the point a guard fires (refusal)
 * or a reasoning aid is invoked.
 */
export function recordGuardFire(
  taskId: string | undefined,
  kind:
    | 'readBeforeEditRefusal'
    | 'bashWrapperRefusal'
    | 'bannedCommandRefusal'
    | 'hookBypassRefusal'
    | 'thinkCall'
    | 'todoUpdate',
): void {
  if (!taskId) return
  const stats = bucket(taskId).stats
  switch (kind) {
    case 'readBeforeEditRefusal':
      stats.readBeforeEditRefusals += 1
      break
    case 'bashWrapperRefusal':
      stats.bashWrapperRefusals += 1
      break
    case 'bannedCommandRefusal':
      stats.bannedCommandRefusals += 1
      break
    case 'hookBypassRefusal':
      stats.hookBypassRefusals += 1
      break
    case 'thinkCall':
      stats.thinkCalls += 1
      break
    case 'todoUpdate':
      stats.todoUpdates += 1
      break
  }
}

/** Snapshot the current guard-fire stats for a task. */
export function getTaskStats(taskId: string | undefined): TaskGuardStats | null {
  if (!taskId) return null
  return byTask.get(taskId)?.stats ?? null
}

/**
 * Record that `read_file` succeeded on a given path inside a task. The
 * read-before-edit guard uses this to decide whether edit_file / multi_edit
 * can proceed. Idempotent: re-recording the same path is harmless.
 */
export function recordReadPath(taskId: string | undefined, path: string): void {
  if (!taskId) return
  bucket(taskId).readPaths.add(path)
}

/**
 * Did this task ever successfully read `path` via read_file? Used by the
 * read-before-edit guard. Returns true when there's no task context (main
 * Agent) so the guard becomes a sub-Agent-only safeguard — main Agent runs in a
 * conversation with the user, who's already in the loop.
 */
export function hasReadPath(taskId: string | undefined, path: string): boolean {
  if (!taskId) return true
  return bucket(taskId).readPaths.has(path)
}

/** Drop all state for a finished task. Called from the task resolver. */
export function forgetTask(taskId: string): void {
  if (byTask.delete(taskId)) {
    log.debug({ taskId }, 'Tool-call tracker cleared for task')
  }
}

/**
 * Build a deterministic signature from the inputs of a `read_file` call.
 * Defaults are normalised so `read_file({ path })` and
 * `read_file({ path, offset: 1 })` hash to the same key.
 */
export function readFileSignature(opts: {
  path: string
  offset?: number
  limit?: number
}): string {
  const offset = opts.offset ?? 1
  const limit = opts.limit ?? 0 // 0 = caller's default
  return `read|${opts.path}|${offset}|${limit}`
}

/**
 * Build a deterministic signature from the inputs of a `grep` call.
 * Pattern + path + glob + output_mode + key flags. We deliberately ignore
 * cosmetic flags (case-insensitive, line numbers) to keep the de-dup
 * tight — a model that flips one cosmetic flag usually meant a duplicate.
 */
export function grepSignature(opts: {
  pattern: string
  path?: string
  glob?: string
  output_mode?: string
  context?: number
  context_before?: number
  context_after?: number
  multiline?: boolean
}): string {
  return [
    'grep',
    opts.pattern,
    opts.path ?? '.',
    opts.glob ?? '',
    opts.output_mode ?? 'content',
    opts.context ?? '',
    opts.context_before ?? '',
    opts.context_after ?? '',
    opts.multiline ? '1' : '',
  ].join('|')
}

/** Test-only: wipe the entire tracker. */
export function _resetTracker(): void {
  byTask.clear()
}

/** Test-only: peek at the per-task bucket. */
export function _peek(taskId: string): Map<string, number> | undefined {
  return byTask.get(taskId)?.counts
}
