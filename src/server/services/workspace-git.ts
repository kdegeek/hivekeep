import { realpathSync } from 'node:fs'
import { basename, resolve, sep } from 'node:path'
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

/**
 * Unified working-tree diff of one file vs HEAD (or vs empty for an untracked
 * file). `isRepo` is false when `dir` is not a git work tree. The path is
 * re-confined to `dir` before it reaches git, so a `../` cannot escape.
 */
export async function gitDiffFile(dir: string, relPath: string): Promise<{ diff: string; isRepo: boolean }> {
  const inside = await runGit(dir, ['rev-parse', '--is-inside-work-tree'])
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') return { diff: '', isRepo: false }

  // Containment: dir is the workspace root — never let a relative path walk out.
  const abs = resolve(dir, relPath)
  if (abs !== dir && !abs.startsWith(dir + sep)) return { diff: '', isRepo: true }
  const rel = abs === dir ? '.' : abs.slice(dir.length + 1)

  const tracked = await runGit(dir, ['ls-files', '--error-unmatch', '--', rel])
  if (tracked.exitCode !== 0) {
    // Untracked file: show the whole content as additions (exit 1 = differs).
    const res = await runGit(dir, ['diff', '--no-index', '--', '/dev/null', rel])
    return { diff: res.stdout, isRepo: true }
  }
  const res = await runGit(dir, ['diff', 'HEAD', '--', rel])
  return { diff: res.stdout, isRepo: true }
}

/**
 * List the working-tree changes of a repo (porcelain), each with its two-letter
 * status code. `core.quotepath=false` keeps accented/UTF-8 paths literal (common
 * in French file names). Returns [] when `dir` is not a git work tree.
 */
export async function gitChangedFiles(dir: string): Promise<{ path: string; status: string }[]> {
  const inside = await runGit(dir, ['rev-parse', '--is-inside-work-tree'])
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') return []
  const res = await runGit(dir, ['-c', 'core.quotepath=false', 'status', '--porcelain'])
  if (res.exitCode !== 0) return []
  const out: { path: string; status: string }[] = []
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue
    const status = line.slice(0, 2).trim()
    let path = line.slice(3)
    // "R  old -> new" / "C  old -> new": keep the destination path.
    const arrow = path.indexOf(' -> ')
    if (arrow !== -1) path = path.slice(arrow + 4)
    // git only wraps paths in quotes for unusual bytes; strip them when present.
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
    out.push({ path, status })
  }
  return out
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
