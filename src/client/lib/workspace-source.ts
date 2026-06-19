import type { WorkspaceSourceRef } from '@/shared/types'

/**
 * Client helpers for the generalized Files API (agent / project / folder
 * sources). Every workspace hook builds its URLs and SSE filters through these
 * so the source (incl. the optional project worktree) is threaded consistently.
 */

/** REST base for a source: `/workspace/<type>/<id>` (no query). */
export function sourceApiBase(source: WorkspaceSourceRef): string {
  return `/workspace/${source.type}/${encodeURIComponent(source.id)}`
}

/** Query string for a source request, always carrying the worktree if set. */
export function sourceQuery(source: WorkspaceSourceRef, params: Record<string, string> = {}): string {
  const qs = new URLSearchParams(params)
  if (source.worktree) qs.set('worktree', source.worktree)
  const s = qs.toString()
  return s ? `?${s}` : ''
}

/** Stable string key (storage, dedupe, dependency arrays). */
export function sourceKey(source: WorkspaceSourceRef): string {
  return source.worktree ? `${source.type}:${source.id}:${source.worktree}` : `${source.type}:${source.id}`
}

export function sameSource(a: WorkspaceSourceRef | null | undefined, b: WorkspaceSourceRef | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.type === b.type && a.id === b.id && (a.worktree ?? '') === (b.worktree ?? '')
}

/** Does a workspace:changed event apply to the source currently in view? */
export function changeMatchesSource(
  data: { agentId?: string; source?: WorkspaceSourceRef },
  active: WorkspaceSourceRef,
): boolean {
  if (data.source) return sameSource(data.source, active)
  // Legacy agent event without a source field.
  return active.type === 'agent' && data.agentId === active.id
}

/** Raw bytes URL (download / inline image|pdf view). */
export function workspaceRawUrl(source: WorkspaceSourceRef, path: string, inline = false): string {
  const params: Record<string, string> = { path }
  if (inline) params.inline = '1'
  return `/api${sourceApiBase(source)}/raw${sourceQuery(source, params)}`
}
