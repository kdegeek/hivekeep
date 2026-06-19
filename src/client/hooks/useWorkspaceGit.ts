import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/client/lib/api'
import { useSSE } from '@/client/hooks/useSSE'
import { sourceApiBase, sourceQuery, changeMatchesSource } from '@/client/lib/workspace-source'
import type { WorkspaceSourceRef, WorkspaceGitStatusDTO, WorkspaceWorktreeDTO } from '@/shared/types'

/**
 * Git context for the active source: the branch + dirty count badge (any repo
 * root) and the list of live worktrees (project sources only). Refetched when
 * the source changes and on workspace:changed so the dirty count tracks edits.
 */
export function useWorkspaceGit(source: WorkspaceSourceRef | null) {
  const [gitStatus, setGitStatus] = useState<WorkspaceGitStatusDTO | null>(null)
  const [worktrees, setWorktrees] = useState<WorkspaceWorktreeDTO[]>([])

  const loadStatus = useCallback(async (s: WorkspaceSourceRef) => {
    try {
      const data = await api.get<{ gitStatus: WorkspaceGitStatusDTO | null }>(
        `${sourceApiBase(s)}/git-status${sourceQuery(s)}`,
      )
      setGitStatus(data.gitStatus)
    } catch {
      setGitStatus(null)
    }
  }, [])

  useEffect(() => {
    if (!source) {
      setGitStatus(null)
      setWorktrees([])
      return
    }
    void loadStatus(source)
    if (source.type === 'project') {
      void api
        .get<{ worktrees: WorkspaceWorktreeDTO[] }>(`/workspace/project/${encodeURIComponent(source.id)}/worktrees`)
        .then((data) => setWorktrees(data.worktrees))
        .catch(() => setWorktrees([]))
    } else {
      setWorktrees([])
    }
  }, [source, loadStatus])

  // Keep the dirty badge fresh as the user (or an agent) writes to the repo.
  const sourceRef = useRef(source)
  sourceRef.current = source
  useSSE({
    'workspace:changed': (data) => {
      const s = sourceRef.current
      if (s && changeMatchesSource(data as { agentId?: string; source?: WorkspaceSourceRef }, s)) void loadStatus(s)
    },
  })

  return { gitStatus, worktrees }
}
