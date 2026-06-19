import { realpathSync } from 'node:fs'
import { basename } from 'node:path'
import { getProject } from '@/server/services/projects'
import { getCloneDir } from '@/server/services/repo-clone'
import { runGit } from '@/server/services/worktree'
import type { WorkspaceWorktreeDTO, WorkspaceGitStatusDTO } from '@/shared/types'

/**
 * Git info for the Files section when browsing a project repo: the list of live
 * worktrees (base clone + per-task worktrees) for the worktree sub-selector, and
 * a lightweight status badge (branch + dirty count). Worktrees are ephemeral —
 * this reflects whatever `git worktree list` reports right now.
 */

/** task/<slug>-<num>-<8hex> → the ticket number, when derivable. */
function parseTicketNumber(branch: string): number | undefined {
  const m = branch.match(/-(\d+)-[0-9a-f]{8}$/)
  return m ? Number(m[1]) : undefined
}

function parseWorktreeList(porcelain: string, cloneDir: string): WorkspaceWorktreeDTO[] {
  let mainReal: string
  try {
    mainReal = realpathSync(cloneDir)
  } catch {
    mainReal = cloneDir
  }

  const out: WorkspaceWorktreeDTO[] = []
  for (const block of porcelain.split('\n\n')) {
    let path = ''
    let branch = ''
    let detached = false
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim()
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
      else if (line.trim() === 'detached') detached = true
    }
    if (!path) continue
    let isMain = false
    try {
      isMain = realpathSync(path) === mainReal
    } catch {
      isMain = path === cloneDir
    }
    out.push({
      id: isMain ? '' : basename(path),
      branch: branch || (detached ? 'detached' : ''),
      isMain,
      ticketNumber: parseTicketNumber(branch),
    })
  }
  // Main clone first, then worktrees in git's order.
  out.sort((a, b) => (a.isMain === b.isMain ? 0 : a.isMain ? -1 : 1))
  return out
}

export async function listProjectWorktrees(projectId: string): Promise<WorkspaceWorktreeDTO[]> {
  const project = await getProject(projectId)
  if (!project?.slug || project.cloneStatus !== 'ready') return []
  const cloneDir = getCloneDir(project.slug)
  const res = await runGit(cloneDir, ['worktree', 'list', '--porcelain'])
  if (res.exitCode !== 0) return []
  return parseWorktreeList(res.stdout, cloneDir)
}

/** Branch + dirty count for any directory; null when it is not a git repo. */
export async function gitStatusSummary(dir: string): Promise<WorkspaceGitStatusDTO | null> {
  const head = await runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (head.exitCode !== 0) return null
  const branch = head.stdout.trim() || 'HEAD'
  const status = await runGit(dir, ['status', '--porcelain'])
  const dirtyCount = status.exitCode === 0 ? status.stdout.split('\n').filter((l) => l.trim().length > 0).length : 0
  return { branch, dirtyCount }
}
