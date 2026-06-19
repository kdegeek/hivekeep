import { resolveAgentByIdOrSlug } from '@/server/services/agent-resolver'
import { agentTarget, WorkspaceFilesError, type WorkspaceTarget } from '@/server/services/workspace-files'
import type { WorkspaceSourceType } from '@/shared/types'

/**
 * Resolves a Files-section browse source (agent / project / folder) to a
 * concrete {@link WorkspaceTarget}. The containment + mutation logic lives in
 * workspace-files.ts and is identical for every source — only the root and the
 * SSE scope differ.
 *
 * Each branch is added as its phase lands:
 *  - `agent`  : P2 (here)
 *  - `folder` : P3
 *  - `project`: P4 (incl. worktree selection)
 */

export class WorkspaceSourceError extends Error {
  constructor(
    public readonly code: 'SOURCE_NOT_FOUND' | 'SOURCE_NOT_READY' | 'SOURCE_INVALID',
    message: string,
  ) {
    super(message)
    this.name = 'WorkspaceSourceError'
  }
}

export interface ResolveSourceOpts {
  /** Project worktree id (project sources only). */
  worktree?: string
}

export async function resolveWorkspaceSource(
  type: string,
  id: string,
  _opts: ResolveSourceOpts = {},
): Promise<WorkspaceTarget> {
  switch (type as WorkspaceSourceType) {
    case 'agent': {
      const agent = resolveAgentByIdOrSlug(id)
      if (!agent) throw new WorkspaceSourceError('SOURCE_NOT_FOUND', 'Agent not found')
      // Use the canonical id so the SSE scope matches sendToAgent.
      return agentTarget(agent.id)
    }
    default:
      throw new WorkspaceSourceError('SOURCE_INVALID', `Unknown source type: ${type}`)
  }
}

/** Re-export so route handlers can narrow both error families in one catch. */
export { WorkspaceFilesError }
