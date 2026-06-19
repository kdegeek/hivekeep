import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { resolveAgentByIdOrSlug } from '@/server/services/agent-resolver'
import { agentTarget, WorkspaceFilesError, type WorkspaceTarget } from '@/server/services/workspace-files'
import { getWorkspaceFolder } from '@/server/services/workspace-folders'
import { getProject } from '@/server/services/projects'
import { getCloneDir } from '@/server/services/repo-clone'
import { getWorktreesDir } from '@/server/services/worktree'
import { listProjectWorktrees } from '@/server/services/workspace-git'
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
  opts: ResolveSourceOpts = {},
): Promise<WorkspaceTarget> {
  switch (type as WorkspaceSourceType) {
    case 'agent': {
      const agent = resolveAgentByIdOrSlug(id)
      if (!agent) throw new WorkspaceSourceError('SOURCE_NOT_FOUND', 'Agent not found')
      // Use the canonical id so the SSE scope matches sendToAgent.
      return agentTarget(agent.id)
    }
    case 'project': {
      const project = await getProject(id)
      if (!project) throw new WorkspaceSourceError('SOURCE_NOT_FOUND', 'Project not found')
      if (!project.slug || project.cloneStatus !== 'ready') {
        throw new WorkspaceSourceError('SOURCE_NOT_READY', 'Project repository is not cloned yet')
      }
      if (opts.worktree) {
        // The worktree id is client-supplied — only accept one git actually
        // reports for this project, never an arbitrary path.
        const worktrees = await listProjectWorktrees(id)
        if (!worktrees.some((w) => w.id === opts.worktree)) {
          throw new WorkspaceSourceError('SOURCE_NOT_FOUND', 'Worktree not found')
        }
        try {
          const root = realpathSync(join(getWorktreesDir(), opts.worktree))
          return { root, source: { type: 'project', id, worktree: opts.worktree } }
        } catch {
          throw new WorkspaceSourceError('SOURCE_NOT_FOUND', 'Worktree no longer exists on disk')
        }
      }
      try {
        const root = realpathSync(getCloneDir(project.slug))
        return { root, source: { type: 'project', id } }
      } catch {
        throw new WorkspaceSourceError('SOURCE_NOT_READY', 'Clone directory is missing')
      }
    }
    case 'folder': {
      const folder = getWorkspaceFolder(id)
      if (!folder) throw new WorkspaceSourceError('SOURCE_NOT_FOUND', 'Folder not found')
      // Re-canonicalize on every browse: a folder removed from disk must fail
      // cleanly, not silently resolve to an empty/escaped root.
      let root: string
      try {
        root = realpathSync(folder.path)
      } catch {
        throw new WorkspaceSourceError('SOURCE_NOT_FOUND', 'Folder no longer exists on disk')
      }
      return { root, source: { type: 'folder', id } }
    }
    default:
      throw new WorkspaceSourceError('SOURCE_INVALID', `Unknown source type: ${type}`)
  }
}

/** Re-export so route handlers can narrow both error families in one catch. */
export { WorkspaceFilesError }
