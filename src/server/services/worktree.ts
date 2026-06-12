/**
 * Per-sub-task worktree orchestrator.
 *
 * Each sub-task that touches code gets its own git worktree linked off
 * the project's local clone (see `repo-clone.ts`). The worktree gives
 * the runner an isolated working tree so concurrent sub-tasks can edit,
 * commit, and push in parallel without trampling each other — and the
 * sub-task's cwd is set to the worktree path so every native tool
 * (`read_file`, `edit_file`, `run_shell`) is naturally scoped to it.
 *
 * The credential helper that drives push/pull/fetch lives on the parent
 * clone's `.git/config` (see `repo-clone.ts:persistCredentialHelper`).
 * Worktrees inherit it by default, so we don't need to touch their
 * config — we just need to inject `HIVEKEEP_GH_TOKEN` into the env of any
 * git network op (the helper reads the PAT from that variable).
 *
 * Path layout:
 *   <repos>/<slug>/                       — main clone (one per project)
 *   <repos>/worktrees/<slug>-task-<8hex>  — per sub-task worktree
 *
 * Branch layout:
 *   task/<slug>-<ticketNumber>-<8hex>
 */

import { resolve } from 'node:path'
import { mkdir, access } from 'node:fs/promises'
import { eq } from 'drizzle-orm'

import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import { db } from '@/server/db/index'
import { projects } from '@/server/db/schema'
import { resolvePat } from '@/server/services/github'
import { getCloneDir } from '@/server/services/repo-clone'

const log = createLogger('worktree')

/** Shared root for every ephemeral sub-task worktree. */
export function getWorktreesDir(): string {
  return resolve(config.repos.baseDir, 'worktrees')
}

/** Absolute path for a project's per-task worktree. Pure. */
export function getWorktreePath(slug: string, shortId: string): string {
  return resolve(getWorktreesDir(), `${slug}-task-${shortId}`)
}

/** Deterministic branch name for a sub-task. Pure. */
export function getWorktreeBranch(slug: string, ticketNumber: number, shortId: string): string {
  return `task/${slug}-${ticketNumber}-${shortId}`
}

/** First 8 hex chars of a task UUID — collision-safe enough for V1
 *  (≈32 bits of entropy per project). */
function shortenTaskId(taskId: string): string {
  return taskId.replace(/-/g, '').slice(0, 8)
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}

async function gitInClone(
  cloneDir: string,
  args: string[],
  env?: Record<string, string>,
): Promise<GitResult> {
  const proc = Bun.spawn(['git', '-C', cloneDir, ...args], {
    env: env ? { ...process.env, ...env } : process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  return { exitCode, stdout, stderr }
}

export interface CreateWorktreeOpts {
  projectId: string
  /** Per-project monotonic ticket number (from `tickets.number`). */
  ticketNumber: number
  /** Full task UUID — we hash the first 8 hex chars into the branch
   *  + path so retries that reuse the same task id are idempotent. */
  taskId: string
}

export interface WorktreeRef {
  /** Absolute filesystem path the sub-task uses as cwd. */
  path: string
  /** Branch checked out in the worktree (`task/<slug>-<num>-<8hex>`). */
  branch: string
  /** Base branch the worktree forked off — sub-ticket 5 uses this for
   *  the auto-rebase step at end of task. */
  baseBranch: string
  /** Resolved PAT for env injection. Never persisted, never logged. */
  pat: string
}

/**
 * Create (or attach idempotently to) a sub-task worktree.
 *
 * Throws on misconfiguration so the sub-task runner can fail fast and
 * surface a clear error to the parent Agent:
 *   - `PROJECT_NOT_FOUND` / `PROJECT_HAS_NO_SLUG` / `NO_GITHUB_REPO`
 *   - `CLONE_NOT_READY` — the parent clone is `cloning`, `error`, or `none`
 *   - `MISSING_PAT` — no vault entry resolves
 *   - `GIT_WORKTREE_ADD_FAILED: <stderr>` — git itself rejected the add
 *
 * Idempotent re-entry: if `<wtPath>` already exists, we trust it
 * (sub-task retries hit the same path) and return without re-running
 * `git worktree add`. Use `deleteWorktree` first if you need a clean
 * re-create.
 */
export async function createWorktree(opts: CreateWorktreeOpts): Promise<WorktreeRef> {
  const row = db.select().from(projects).where(eq(projects.id, opts.projectId)).get()
  if (!row) throw new Error('PROJECT_NOT_FOUND')
  if (!row.slug) throw new Error('PROJECT_HAS_NO_SLUG')
  if (!row.githubRepo) throw new Error('NO_GITHUB_REPO')
  if (row.cloneStatus !== 'ready') throw new Error('CLONE_NOT_READY')

  const pat = await resolvePat(row.githubPatVaultKey)
  if (!pat) throw new Error('MISSING_PAT')

  const shortId = shortenTaskId(opts.taskId)
  const cloneDir = getCloneDir(row.slug)
  const wtPath = getWorktreePath(row.slug, shortId)
  const branch = getWorktreeBranch(row.slug, opts.ticketNumber, shortId)
  const baseBranch = row.defaultBranch ?? 'main'

  await mkdir(getWorktreesDir(), { recursive: true })

  if (await dirExists(wtPath)) {
    log.info(
      { projectId: opts.projectId, taskId: opts.taskId, wtPath, branch },
      'Worktree already present, attaching',
    )
    return { path: wtPath, branch, baseBranch, pat }
  }

  // Best-effort fetch so the new branch forks off the latest remote tip.
  // Failure here (e.g. transient network) is not fatal — we fall back to
  // whatever `origin/<baseBranch>` already points to in the local clone.
  const fetch = await gitInClone(
    cloneDir,
    ['fetch', '--quiet', 'origin', baseBranch],
    { HIVEKEEP_GH_TOKEN: pat },
  )
  if (fetch.exitCode !== 0) {
    log.warn(
      { projectId: opts.projectId, baseBranch, stderr: fetch.stderr.slice(0, 200) },
      'fetch before worktree add failed — using local origin ref',
    )
  }

  const add = await gitInClone(cloneDir, [
    'worktree', 'add',
    wtPath,
    '-b', branch,
    `origin/${baseBranch}`,
  ])
  if (add.exitCode !== 0) {
    throw new Error(`GIT_WORKTREE_ADD_FAILED: ${add.stderr.slice(0, 500)}`)
  }

  log.info(
    { projectId: opts.projectId, taskId: opts.taskId, wtPath, branch, baseBranch },
    'Worktree created',
  )
  return { path: wtPath, branch, baseBranch, pat }
}

export interface DeleteWorktreeOpts {
  projectId: string
  /** Worktree path returned by `createWorktree`. */
  path: string
  /** Local branch to also delete (`git branch -D`). Omit to preserve
   *  the branch — sub-ticket 5 uses this for the "needs human review"
   *  path where the branch stays pushed on the remote. */
  branch?: string
  /** Force removal even if the worktree has uncommitted changes or its
   *  directory was deleted out-of-band. The TTL sweeper sets this. */
  force?: boolean
}

/**
 * Remove a sub-task worktree. Best-effort: failures are logged but
 * never thrown, so cleanup never blocks the parent task's lifecycle.
 *
 * If `<path>` was already deleted out-of-band, we still run
 * `git worktree prune` so the parent clone's bookkeeping doesn't keep
 * pointing at a ghost worktree.
 */
export async function deleteWorktree(opts: DeleteWorktreeOpts): Promise<void> {
  const row = db.select().from(projects).where(eq(projects.id, opts.projectId)).get()
  if (!row || !row.slug) {
    log.warn({ projectId: opts.projectId }, 'deleteWorktree called for unknown project')
    return
  }
  const cloneDir = getCloneDir(row.slug)

  const removeArgs = ['worktree', 'remove']
  if (opts.force) removeArgs.push('--force')
  removeArgs.push(opts.path)

  const remove = await gitInClone(cloneDir, removeArgs)
  if (remove.exitCode !== 0) {
    // Common cause: the dir was rm-rf'd externally. Prune so the parent
    // clone forgets about the orphan; the branch deletion below still
    // tries on its own.
    const prune = await gitInClone(cloneDir, ['worktree', 'prune'])
    log.warn(
      {
        projectId: opts.projectId,
        wtPath: opts.path,
        removeStderr: remove.stderr.slice(0, 200),
        pruneExit: prune.exitCode,
      },
      'git worktree remove failed; ran prune',
    )
  }

  if (opts.branch) {
    const branchDel = await gitInClone(cloneDir, ['branch', '-D', opts.branch])
    if (branchDel.exitCode !== 0) {
      log.warn(
        {
          projectId: opts.projectId,
          branch: opts.branch,
          stderr: branchDel.stderr.slice(0, 200),
        },
        'git branch -D failed (branch may already be gone)',
      )
    }
  }
}

/**
 * Build the env block a sub-task runner should pass to any subprocess
 * that runs git network ops inside the worktree. Always extends
 * `process.env`; the only secret injected is `HIVEKEEP_GH_TOKEN`.
 *
 * The credential helper in the parent clone's `.git/config` reads this
 * variable to authenticate against `https://github.com`.
 */
export function buildWorktreeEnv(
  pat: string,
  extras?: Record<string, string>,
): Record<string, string | undefined> {
  return {
    ...process.env,
    HIVEKEEP_GH_TOKEN: pat,
    ...extras,
  }
}
