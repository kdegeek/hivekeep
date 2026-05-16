/**
 * Per-task tracker of read-style tool calls (read_file / grep).
 *
 * On real prod tasks the sub-Kin agent often re-issues the same `read_file`
 * or `grep` it just did a few steps ago — the prompt rule "don't re-read
 * what's already in your context" only catches part of it. This tracker
 * decorates the tool response with a `previousCallCount` hint when the
 * same signature repeats inside a task. It's non-blocking on purpose: the
 * model may legitimately re-read after an edit, or after a long thought,
 * but it now has a clear signal that the prior result is still upstream
 * in the conversation.
 *
 * State lives in-process; it's cleared when a task resolves (completed /
 * failed / cancelled). For non-task contexts (main Kin conversation) the
 * tracker silently no-ops, since main-Kin context is conversational and
 * the same prompt rule applies less cleanly there.
 */

import { createLogger } from '@/server/logger'

const log = createLogger('tool-call-tracker')

export type TrackedKind = 'read_file' | 'grep'

interface PerTaskCounts {
  // signature → number of previous calls (0 the first time, >=1 on repeats).
  counts: Map<string, number>
  // Set of file paths the task has already read via read_file. Used by the
  // edit/multi-edit "read-before-edit" guard (ported from opencode) to
  // prevent hallucinated edits on files the sub-Kin hasn't actually seen.
  readPaths: Set<string>
}

const byTask = new Map<string, PerTaskCounts>()

function bucket(taskId: string): PerTaskCounts {
  let entry = byTask.get(taskId)
  if (!entry) {
    entry = { counts: new Map(), readPaths: new Set() }
    byTask.set(taskId, entry)
  }
  return entry
}

/**
 * Note a tool call. Returns the number of previous calls with the same
 * signature in this task; 0 means it's a fresh call. The caller decides
 * how to surface this to the model.
 *
 * When `taskId` is undefined (main Kin contexts), the tracker no-ops and
 * always returns 0 — see module doc.
 */
export function noteCall(
  taskId: string | undefined,
  _kind: TrackedKind,
  signature: string,
): { previousCallCount: number } {
  if (!taskId) return { previousCallCount: 0 }
  const entry = bucket(taskId)
  const prev = entry.counts.get(signature) ?? 0
  entry.counts.set(signature, prev + 1)
  return { previousCallCount: prev }
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
 * Kin) so the guard becomes a sub-Kin-only safeguard — main Kin runs in a
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
