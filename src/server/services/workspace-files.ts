import { join, sep, dirname, basename } from 'node:path'
import { constants } from 'node:fs'
import { lstat, realpath, readdir, open, stat } from 'node:fs/promises'
// Sync mutations on purpose: fs/promises is mock.module'd (mkdir → no-op) by
// image-tools.test.ts and the mock leaks process-wide under bun test.
import {
  mkdirSync,
  renameSync,
  rmSync,
  copyFileSync,
  readdirSync,
  lstatSync,
  existsSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import { sseManager } from '@/server/sse/index'
import { isPathBlocked } from '@/server/tools/filesystem-tools'
import { guessMimeType, isBinary } from '@/server/services/file-kind'
import type { WorkspaceEntry, WorkspaceFileInfo, WorkspaceFileKind } from '@/shared/types'

const log = createLogger('workspace-files')

/**
 * Workspace files service — the user-facing Files section API (see files.md).
 *
 * Containment is STRICTER than the agent filesystem tools: a path can never
 * leave the target workspace (no absolute paths, no `..`, no symlink escape —
 * leaf included). Known residual limit: hardlinks (files.md § 7.6).
 */

export type WorkspaceErrorCode =
  | 'PATH_FORBIDDEN'
  | 'FILE_NOT_FOUND'
  | 'IS_DIRECTORY'
  | 'NOT_A_DIRECTORY'
  | 'FILE_TOO_LARGE'
  | 'INVALID_NAME'
  | 'DEST_EXISTS'
  | 'CONFLICT'
  | 'COPY_TOO_LARGE'

export class WorkspaceFilesError extends Error {
  constructor(
    public readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'WorkspaceFilesError'
  }
}

const forbidden = (detail: string) => new WorkspaceFilesError('PATH_FORBIDDEN', `Path not allowed: ${detail}`)

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f]/

export function workspaceRootFor(agentId: string): string {
  return join(config.workspace.baseDir, agentId)
}

/**
 * Validate a single path component as a user-provided file/dir name
 * (rename, create, upload filename). files.md § 7.5.
 */
export function validateEntryName(name: string): void {
  if (!name || !name.trim()) throw new WorkspaceFilesError('INVALID_NAME', 'Name is empty')
  if (name === '.' || name === '..') throw new WorkspaceFilesError('INVALID_NAME', 'Reserved name')
  if (name.includes('/') || name.includes('\\') || CONTROL_CHARS.test(name)) {
    throw new WorkspaceFilesError('INVALID_NAME', 'Name contains forbidden characters')
  }
  if (Buffer.byteLength(name, 'utf8') > 255) {
    throw new WorkspaceFilesError('INVALID_NAME', 'Name too long (max 255 bytes)')
  }
}

/** Normalize a workspace-relative path. Rejects absolute, `..`, control chars. */
export function normalizeRelPath(relPath: string): string {
  if (typeof relPath !== 'string') throw forbidden('not a string')
  if (CONTROL_CHARS.test(relPath)) throw forbidden('control characters')
  if (relPath.includes('\\')) throw forbidden('backslash separator')
  if (relPath.startsWith('/') || /^[a-zA-Z]:/.test(relPath)) throw forbidden('absolute path')
  const parts = relPath.split('/').filter((p) => p !== '' && p !== '.')
  for (const part of parts) {
    if (part === '..' || part === '~') throw forbidden('traversal component')
  }
  return parts.join('/')
}

export interface ResolvedWorkspacePath {
  /** Canonical absolute path, safe to hand to fs ops (realpath'd through every existing component). */
  abs: string
  /** Canonical workspace root. */
  root: string
  /** Normalized path relative to the root ('' = the root itself). */
  rel: string
  /** Whether the final target currently exists. */
  exists: boolean
}

const isContained = (candidate: string, root: string) => candidate === root || candidate.startsWith(root + sep)

/**
 * Core containment resolver (root-based so it is unit-testable without config).
 *
 * - normalizes the relative path (rejects `..`/absolute/control chars)
 * - canonicalizes the deepest EXISTING ancestor (catches symlinked parents)
 * - canonicalizes the FULL path when the leaf exists (catches symlink leaves —
 *   `ln -s /etc/passwd secret` must not pass a parent-only check)
 * - `forWrite` refuses any symlink leaf outright
 *
 * NOTE (TOCTOU): callers performing the actual fs op must still open with
 * O_NOFOLLOW where possible — an agent shell can plant a symlink between this
 * check and the op. See openWorkspaceFile().
 */
export async function resolveInRoot(
  root: string,
  relPath: string,
  opts: { forWrite?: boolean; unlink?: boolean } = {},
): Promise<ResolvedWorkspacePath> {
  const rel = normalizeRelPath(relPath)

  let rootReal: string
  try {
    rootReal = await realpath(root)
  } catch {
    // Workspace dir does not exist yet (lazy creation) — nothing on disk can
    // be a symlink below it.
    const abs = rel ? join(root, rel) : root
    if (isPathBlocked(abs)) throw forbidden('blocked path')
    return { abs, root, rel, exists: false }
  }

  const abs = rel ? join(rootReal, rel) : rootReal

  // Walk up to the deepest existing ancestor and canonicalize it.
  let ancestor = abs
  let suffix = ''
  while (true) {
    try {
      await lstat(ancestor)
      break
    } catch {
      if (ancestor === rootReal) break
      suffix = sep + basename(ancestor) + suffix
      ancestor = dirname(ancestor)
    }
  }

  let exists = false
  let canonical: string
  try {
    const ancestorReal = await realpath(ancestor)
    canonical = ancestorReal + suffix
    if (suffix === '') {
      // The full target exists: realpath above resolved the leaf too.
      exists = true
      const leafStat = await lstat(abs)
      if (leafStat.isSymbolicLink()) {
        if (opts.forWrite) throw forbidden('symlink target (write)')
        if (opts.unlink) {
          // delete/move operate on the LINK itself (safe — never follows it):
          // canonicalize the parent only and keep the leaf name as-is.
          canonical = join(await realpath(dirname(abs)), basename(abs))
        }
        // otherwise canonical points at the link target — containment check below decides.
      }
    }
  } catch (err) {
    if (err instanceof WorkspaceFilesError) throw err
    // Broken symlink somewhere on the existing part of the path.
    throw forbidden('unresolvable path')
  }

  if (!isContained(canonical, rootReal)) throw forbidden('escapes workspace')
  if (isPathBlocked(canonical)) throw forbidden('blocked path')

  return { abs: canonical, root: rootReal, rel, exists }
}

export function resolveWorkspacePath(
  agentId: string,
  relPath: string,
  opts: { forWrite?: boolean; unlink?: boolean } = {},
): Promise<ResolvedWorkspacePath> {
  return resolveInRoot(workspaceRootFor(agentId), relPath, opts)
}

/**
 * Open a file for reading with O_NOFOLLOW on the leaf (TOCTOU guard: the path
 * was canonicalized by resolveInRoot, so a symlink appearing here is a race).
 */
async function openNoFollow(absPath: string) {
  try {
    return await open(absPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ELOOP' || e.code === 'EMLINK') throw forbidden('symlink leaf')
    if (e.code === 'ENOENT') throw new WorkspaceFilesError('FILE_NOT_FOUND', 'File not found')
    if (e.code === 'EISDIR') throw new WorkspaceFilesError('IS_DIRECTORY', 'Path is a directory')
    throw err
  }
}

// ─── ls ──────────────────────────────────────────────────────────────────────

export async function listWorkspaceDir(agentId: string, relPath: string): Promise<{ path: string; entries: WorkspaceEntry[] }> {
  const resolved = await resolveWorkspacePath(agentId, relPath)
  if (!resolved.exists) {
    // Lazy workspace: the root not existing yet is an empty listing, a missing
    // subdirectory is a 404.
    if (resolved.rel === '') return { path: '', entries: [] }
    throw new WorkspaceFilesError('FILE_NOT_FOUND', `No such directory: ${resolved.rel}`)
  }

  const dirStat = await lstat(resolved.abs)
  if (!dirStat.isDirectory()) throw new WorkspaceFilesError('NOT_A_DIRECTORY', `Not a directory: ${resolved.rel}`)

  const dirents = await readdir(resolved.abs, { withFileTypes: true })
  const entries: WorkspaceEntry[] = []
  for (const dirent of dirents) {
    const entryAbs = join(resolved.abs, dirent.name)
    let entryStat
    try {
      entryStat = await lstat(entryAbs)
    } catch {
      continue // raced away
    }
    const isSymlink = entryStat.isSymbolicLink()
    let type: 'file' | 'dir' = entryStat.isDirectory() ? 'dir' : 'file'
    if (isSymlink) {
      // Display symlinked dirs as dirs when their target stays confined.
      try {
        const targetReal = await realpath(entryAbs)
        if (isContained(targetReal, resolved.root)) {
          type = (await lstat(targetReal)).isDirectory() ? 'dir' : 'file'
        }
      } catch {
        /* broken link: keep as file */
      }
    }
    entries.push({
      name: dirent.name,
      path: resolved.rel ? `${resolved.rel}/${dirent.name}` : dirent.name,
      type,
      size: type === 'dir' ? 0 : entryStat.size,
      modifiedAt: entryStat.mtimeMs,
      isSymlink,
    })
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })

  return { path: resolved.rel, entries }
}

// ─── read ────────────────────────────────────────────────────────────────────

const maxEditableBytes = () => config.workspaceFiles.maxEditableSizeMb * 1024 * 1024

export async function readWorkspaceFile(agentId: string, relPath: string): Promise<WorkspaceFileInfo> {
  const resolved = await resolveWorkspacePath(agentId, relPath)
  if (!resolved.exists) throw new WorkspaceFilesError('FILE_NOT_FOUND', `No such file: ${resolved.rel}`)

  const fileStat = await stat(resolved.abs)
  if (fileStat.isDirectory()) throw new WorkspaceFilesError('IS_DIRECTORY', `Path is a directory: ${resolved.rel}`)

  const name = basename(resolved.abs)
  const mimeType = guessMimeType(name)
  const base = {
    path: resolved.rel,
    name,
    size: fileStat.size,
    modifiedAt: fileStat.mtimeMs,
    mimeType,
  }

  if (mimeType.startsWith('image/')) return { ...base, kind: 'image', content: null }
  if (mimeType === 'application/pdf') return { ...base, kind: 'pdf', content: null }

  const handle = await openNoFollow(resolved.abs)
  try {
    const head = Buffer.alloc(Math.min(8192, fileStat.size))
    if (head.length > 0) await handle.read(head, 0, head.length, 0)
    if (isBinary(head)) return { ...base, kind: 'binary', content: null }
    if (fileStat.size > maxEditableBytes()) return { ...base, kind: 'too-large', content: null }
    const content = (await handle.readFile()).toString('utf8')
    return { ...base, kind: 'text', content }
  } finally {
    await handle.close()
  }
}

// ─── write ───────────────────────────────────────────────────────────────────

export async function writeWorkspaceFile(
  agentId: string,
  relPath: string,
  content: string,
  opts: { baseModifiedAt?: number; createOnly?: boolean } = {},
): Promise<{ path: string; size: number; modifiedAt: number }> {
  const resolved = await resolveWorkspacePath(agentId, relPath, { forWrite: true })
  if (resolved.rel === '') throw new WorkspaceFilesError('IS_DIRECTORY', 'Cannot write the workspace root')

  if (Buffer.byteLength(content, 'utf8') > maxEditableBytes()) {
    throw new WorkspaceFilesError('FILE_TOO_LARGE', `Content exceeds ${config.workspaceFiles.maxEditableSizeMb} MB`)
  }

  const existedBefore = resolved.exists
  if (resolved.exists) {
    const current = await lstat(resolved.abs)
    if (current.isDirectory()) throw new WorkspaceFilesError('IS_DIRECTORY', `Path is a directory: ${resolved.rel}`)
    if (opts.createOnly) throw new WorkspaceFilesError('DEST_EXISTS', `Already exists: ${resolved.rel}`)
    // Optimistic concurrency: the client echoes the mtime it read; a different
    // mtime on disk means someone (typically the agent) wrote in between.
    if (opts.baseModifiedAt !== undefined && Math.abs(current.mtimeMs - opts.baseModifiedAt) > 1) {
      throw new WorkspaceFilesError('CONFLICT', `File changed on disk: ${resolved.rel}`)
    }
  } else {
    // New file: the leaf is user-named — enforce the name rules.
    validateEntryName(basename(resolved.abs))
    // Sync mkdir on purpose: fs/promises.mkdir is mock.module'd into a no-op
    // by image-tools.test.ts and the mock leaks process-wide under bun test.
    mkdirSync(dirname(resolved.abs), { recursive: true })
  }

  // O_NOFOLLOW write: resolveWorkspacePath refused symlink leaves, but an agent
  // shell can plant one between the check and this op (TOCTOU, files.md § 7.2).
  let handle
  try {
    handle = await open(
      resolved.abs,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    )
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ELOOP' || e.code === 'EMLINK') throw forbidden('symlink leaf')
    if (e.code === 'EISDIR') throw new WorkspaceFilesError('IS_DIRECTORY', 'Path is a directory')
    throw err
  }
  try {
    await handle.writeFile(content, 'utf8')
  } finally {
    await handle.close()
  }

  const written = await stat(resolved.abs)
  log.info({ agentId, path: resolved.rel, size: written.size }, 'Workspace file written via Files API')
  emitWorkspaceChanged(agentId, [
    { path: resolved.rel, type: existedBefore ? 'modified' : 'created', isDirectory: false, modifiedAt: written.mtimeMs },
  ])
  return { path: resolved.rel, size: written.size, modifiedAt: written.mtimeMs }
}

// ─── workspace:changed SSE (files.md § 8) ────────────────────────────────────

export interface WorkspaceChange {
  path: string
  type: 'created' | 'modified' | 'deleted' | 'renamed'
  isDirectory: boolean
  newPath?: string
  /** Resulting mtime — the emitting device uses it to ignore its own echo. */
  modifiedAt?: number
}

/** Recursive ops emit ONE coarse change on the folder; `changes` stays small. */
const MAX_CHANGES_PER_EVENT = 20

/**
 * Single emission point for every workspace mutation (REST routes AND the
 * native tools that write into the static workspace). Scope: sendToAgent —
 * event tied to an Agent, the client filters by agentId (sse.md).
 */
export function emitWorkspaceChanged(agentId: string, changes: WorkspaceChange[]): void {
  if (changes.length === 0) return
  const bounded =
    changes.length > MAX_CHANGES_PER_EVENT
      ? [{ path: commonParentOf(changes.map((c) => c.path)), type: 'modified' as const, isDirectory: true }]
      : changes
  try {
    sseManager.sendToAgent(agentId, {
      type: 'workspace:changed',
      agentId,
      data: { agentId, changes: bounded },
    })
  } catch (err) {
    // Real-time sync is best-effort — emission must never break the mutation
    // that triggered it (tool writes catch errors and would report failure).
    log.warn({ agentId, err: (err as Error).message }, 'workspace:changed emission failed')
  }
}

function commonParentOf(paths: string[]): string {
  if (paths.length === 0) return ''
  let prefix = paths[0]!.split('/').slice(0, -1)
  for (const p of paths.slice(1)) {
    const parts = p.split('/').slice(0, -1)
    let i = 0
    while (i < prefix.length && i < parts.length && prefix[i] === parts[i]) i++
    prefix = prefix.slice(0, i)
  }
  return prefix.join('/')
}

/**
 * Tool-side emission: native tools pass their execution context + the absolute
 * path they wrote. Skipped for per-task worktrees (workspaceOverride) and for
 * writes outside the static workspace (agents are allowed to write elsewhere).
 */
export function emitWorkspaceChangedForTool(
  ctx: { agentId: string; workspaceOverride?: { path: string } },
  absPath: string,
  type: WorkspaceChange['type'],
  opts: { isDirectory?: boolean } = {},
): void {
  if (ctx.workspaceOverride) return
  const root = resolve(workspaceRootFor(ctx.agentId))
  const abs = resolve(absPath)
  if (abs !== root && !abs.startsWith(root + sep)) return
  const rel = abs === root ? '' : abs.slice(root.length + 1)
  emitWorkspaceChanged(ctx.agentId, [{ path: rel, type, isDirectory: opts.isDirectory ?? false }])
}

// ─── mutations: mkdir / move / copy / delete / upload ────────────────────────

export async function mkdirWorkspace(agentId: string, relPath: string): Promise<{ path: string }> {
  const resolved = await resolveWorkspacePath(agentId, relPath, { forWrite: true })
  if (resolved.rel === '') throw new WorkspaceFilesError('INVALID_NAME', 'Folder name is required')
  if (resolved.exists) throw new WorkspaceFilesError('DEST_EXISTS', `Already exists: ${resolved.rel}`)
  validateEntryName(basename(resolved.abs))
  mkdirSync(resolved.abs, { recursive: true })
  log.info({ agentId, path: resolved.rel }, 'Workspace folder created via Files API')
  emitWorkspaceChanged(agentId, [{ path: resolved.rel, type: 'created', isDirectory: true }])
  return { path: resolved.rel }
}

/**
 * Move/rename — cross-workspace when fromAgentId differs (files.md § 6.5).
 * `from` is validated against the SOURCE agent's root, `to` against the target's.
 */
export async function moveWorkspaceEntry(params: {
  agentId: string
  from: string
  to: string
  fromAgentId?: string
}): Promise<{ from: string; to: string }> {
  const sourceAgent = params.fromAgentId ?? params.agentId
  const source = await resolveInRoot(workspaceRootFor(sourceAgent), params.from, { unlink: true })
  if (!source.exists) throw new WorkspaceFilesError('FILE_NOT_FOUND', `No such file: ${source.rel}`)
  if (source.rel === '') throw forbidden('cannot move the workspace root')

  const dest = await resolveWorkspacePath(params.agentId, params.to, { forWrite: true })
  if (dest.rel === '') throw forbidden('cannot overwrite the workspace root')
  if (dest.exists) throw new WorkspaceFilesError('DEST_EXISTS', `Already exists: ${dest.rel}`)
  validateEntryName(basename(dest.abs))

  mkdirSync(dirname(dest.abs), { recursive: true })
  const isDirectory = lstatSync(source.abs).isDirectory()
  renameSync(source.abs, dest.abs)
  log.info({ agentId: params.agentId, fromAgentId: sourceAgent, from: source.rel, to: dest.rel }, 'Workspace entry moved via Files API')
  if (sourceAgent !== params.agentId) {
    // Cross-workspace cut/paste: one event per touched agent.
    emitWorkspaceChanged(sourceAgent, [{ path: source.rel, type: 'deleted', isDirectory }])
    emitWorkspaceChanged(params.agentId, [{ path: dest.rel, type: 'created', isDirectory }])
  } else {
    emitWorkspaceChanged(params.agentId, [{ path: source.rel, type: 'renamed', isDirectory, newPath: dest.rel }])
  }
  return { from: source.rel, to: dest.rel }
}

/** "name.ext" → "name (copy).ext" → "name (copy 2).ext" … */
function copySuffixed(destAbs: string): string {
  if (!existsSync(destAbs)) return destAbs
  const dir = dirname(destAbs)
  const full = basename(destAbs)
  const dot = full.startsWith('.') ? -1 : full.lastIndexOf('.')
  const stem = dot > 0 ? full.slice(0, dot) : full
  const ext = dot > 0 ? full.slice(dot) : ''
  for (let n = 1; n <= 100; n++) {
    const candidate = join(dir, `${stem} (copy${n === 1 ? '' : ` ${n}`})${ext}`)
    if (!existsSync(candidate)) return candidate
  }
  throw new WorkspaceFilesError('DEST_EXISTS', 'Too many copies of this name')
}

interface CopyBudget {
  bytesLeft: number
  entriesLeft: number
}

/** Streamed recursive copy with hard budgets — no pre-walk (files.md § 6.5). */
function copyRecursive(srcAbs: string, dstAbs: string, budget: CopyBudget): void {
  const srcStat = lstatSync(srcAbs)
  if (srcStat.isSymbolicLink()) return // never copy through links (escape + cycles)
  budget.entriesLeft--
  if (budget.entriesLeft < 0) throw new WorkspaceFilesError('COPY_TOO_LARGE', 'Copy exceeds the entry budget')
  if (srcStat.isDirectory()) {
    mkdirSync(dstAbs, { recursive: true })
    for (const name of readdirSync(srcAbs)) {
      copyRecursive(join(srcAbs, name), join(dstAbs, name), budget)
    }
    return
  }
  budget.bytesLeft -= srcStat.size
  if (budget.bytesLeft < 0) throw new WorkspaceFilesError('COPY_TOO_LARGE', 'Copy exceeds the size budget')
  copyFileSync(srcAbs, dstAbs)
}

export async function copyWorkspaceEntry(params: {
  agentId: string
  from: string
  to: string
  fromAgentId?: string
}): Promise<{ from: string; to: string }> {
  const sourceAgent = params.fromAgentId ?? params.agentId
  const source = await resolveInRoot(workspaceRootFor(sourceAgent), params.from)
  if (!source.exists) throw new WorkspaceFilesError('FILE_NOT_FOUND', `No such file: ${source.rel}`)
  if (source.rel === '') throw forbidden('cannot copy the workspace root')

  const dest = await resolveWorkspacePath(params.agentId, params.to, { forWrite: true })
  if (dest.rel === '') throw forbidden('cannot overwrite the workspace root')
  validateEntryName(basename(dest.abs))

  mkdirSync(dirname(dest.abs), { recursive: true })
  const finalAbs = copySuffixed(dest.abs)
  const budget: CopyBudget = {
    bytesLeft: config.workspaceFiles.maxCopySizeMb * 1024 * 1024,
    entriesLeft: config.workspaceFiles.maxCopyEntries,
  }
  try {
    copyRecursive(source.abs, finalAbs, budget)
  } catch (err) {
    // Best-effort cleanup of the partial copy — never leave half a tree behind.
    rmSync(finalAbs, { recursive: true, force: true })
    throw err
  }
  const finalRel = dest.rel === basename(dest.abs)
    ? basename(finalAbs)
    : `${dirname(dest.rel)}/${basename(finalAbs)}`
  log.info({ agentId: params.agentId, fromAgentId: sourceAgent, from: source.rel, to: finalRel }, 'Workspace entry copied via Files API')
  emitWorkspaceChanged(params.agentId, [{ path: finalRel, type: 'created', isDirectory: lstatSync(finalAbs).isDirectory() }])
  return { from: source.rel, to: finalRel }
}

export async function deleteWorkspaceEntry(agentId: string, relPath: string): Promise<{ path: string }> {
  const resolved = await resolveWorkspacePath(agentId, relPath, { unlink: true })
  if (!resolved.exists) throw new WorkspaceFilesError('FILE_NOT_FOUND', `No such file: ${resolved.rel}`)
  if (resolved.rel === '') throw forbidden('cannot delete the workspace root')
  const isDirectory = lstatSync(resolved.abs).isDirectory()
  rmSync(resolved.abs, { recursive: true, force: false })
  log.info({ agentId, path: resolved.rel }, 'Workspace entry deleted via Files API')
  emitWorkspaceChanged(agentId, [{ path: resolved.rel, type: 'deleted', isDirectory }])
  return { path: resolved.rel }
}

const maxUploadBytes = () =>
  config.workspaceFiles.maxUploadSizeMb > 0 ? config.workspaceFiles.maxUploadSizeMb * 1024 * 1024 : Infinity

export interface UploadedWorkspaceFile {
  path: string
  size: number
  modifiedAt: number
}

/**
 * Multi-file upload into a workspace directory. Multipart filenames are
 * client-controlled: only their basename survives, and collisions get the
 * " (copy N)" suffix — an upload never silently overwrites (files.md § 6.6).
 */
export async function uploadWorkspaceFiles(
  agentId: string,
  dirPath: string,
  files: Array<{ name: string; buffer: Buffer }>,
): Promise<{ files: UploadedWorkspaceFile[]; errors: Array<{ name: string; code: WorkspaceErrorCode }> }> {
  const dir = await resolveWorkspacePath(agentId, dirPath, { forWrite: true })
  if (dir.exists && !(await lstat(dir.abs)).isDirectory()) {
    throw new WorkspaceFilesError('NOT_A_DIRECTORY', `Not a directory: ${dir.rel}`)
  }
  mkdirSync(dir.abs, { recursive: true })

  const uploaded: UploadedWorkspaceFile[] = []
  const errors: Array<{ name: string; code: WorkspaceErrorCode }> = []
  for (const file of files) {
    // basename() strips any path smuggled in the multipart filename.
    const name = basename(file.name)
    try {
      validateEntryName(name)
      if (file.buffer.byteLength > maxUploadBytes()) {
        throw new WorkspaceFilesError('FILE_TOO_LARGE', `File exceeds ${config.workspaceFiles.maxUploadSizeMb} MB`)
      }
      const destAbs = copySuffixed(join(dir.abs, name))
      const handle = await open(destAbs, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW)
      try {
        await handle.writeFile(file.buffer)
      } finally {
        await handle.close()
      }
      const written = await stat(destAbs)
      uploaded.push({
        path: dir.rel ? `${dir.rel}/${basename(destAbs)}` : basename(destAbs),
        size: written.size,
        modifiedAt: written.mtimeMs,
      })
    } catch (err) {
      errors.push({
        name,
        code: err instanceof WorkspaceFilesError ? err.code : 'INVALID_NAME',
      })
    }
  }
  log.info({ agentId, dir: dir.rel, count: uploaded.length, failed: errors.length }, 'Workspace upload via Files API')
  emitWorkspaceChanged(
    agentId,
    uploaded.map((f) => ({ path: f.path, type: 'created' as const, isDirectory: false, modifiedAt: f.modifiedAt })),
  )
  return { files: uploaded, errors }
}

// ─── search & resolve-paths (chat integrations, files.md § 6.7/6.8) ──────────

export interface WorkspaceSearchHit {
  path: string
  name: string
  size: number
  modifiedAt: number
}

/**
 * Filename/path substring search. lstat-based walk that NEVER descends into
 * symlinked directories (escape + cycles), skips the heavy dirs the prompt
 * tree skips (IGNORED_DIRS), and stops at the entry budget.
 */
export async function searchWorkspaceFiles(agentId: string, query: string, limit: number): Promise<WorkspaceSearchHit[]> {
  const { IGNORED_DIRS } = await import('@/server/services/workspace-tree')
  const resolved = await resolveWorkspacePath(agentId, '')
  if (!resolved.exists) return []
  const cap = Math.min(Math.max(1, limit), config.workspaceFiles.searchMaxResults)
  const needle = query.toLowerCase()
  const hits: WorkspaceSearchHit[] = []
  let budget = config.workspaceFiles.searchMaxEntries

  const walk = (dirAbs: string, dirRel: string): boolean => {
    let dirents
    try {
      dirents = readdirSync(dirAbs, { withFileTypes: true })
    } catch {
      return true
    }
    for (const dirent of dirents) {
      if (--budget < 0) return false
      const rel = dirRel ? `${dirRel}/${dirent.name}` : dirent.name
      const abs = join(dirAbs, dirent.name)
      if (dirent.isSymbolicLink()) continue
      if (dirent.isDirectory()) {
        if (IGNORED_DIRS.has(dirent.name)) continue
        if (!walk(abs, rel)) return false
        continue
      }
      if (!dirent.isFile()) continue
      if (needle && !rel.toLowerCase().includes(needle)) continue
      let entryStat
      try {
        entryStat = lstatSync(abs)
      } catch {
        continue
      }
      hits.push({ path: rel, name: dirent.name, size: entryStat.size, modifiedAt: entryStat.mtimeMs })
      if (hits.length >= cap) return false
    }
    return true
  }

  walk(resolved.abs, '')
  return hits
}

/** Existence check for candidate paths from chat messages — files only,
 *  invalid/escaping candidates silently dropped (they're regex output). */
export async function resolveWorkspacePaths(agentId: string, paths: string[]): Promise<string[]> {
  const existing: string[] = []
  for (const path of paths.slice(0, 50)) {
    try {
      const resolved = await resolveWorkspacePath(agentId, path)
      if (!resolved.exists) continue
      if ((await lstat(resolved.abs)).isFile()) existing.push(resolved.rel)
    } catch {
      // candidates come from a regex — not an error
    }
  }
  return existing
}

// ─── raw (download / inline view) ────────────────────────────────────────────

export async function statWorkspaceFileForRaw(
  agentId: string,
  relPath: string,
): Promise<{ abs: string; name: string; size: number; mimeType: string }> {
  const resolved = await resolveWorkspacePath(agentId, relPath)
  if (!resolved.exists) throw new WorkspaceFilesError('FILE_NOT_FOUND', `No such file: ${resolved.rel}`)
  const fileStat = await stat(resolved.abs)
  if (fileStat.isDirectory()) throw new WorkspaceFilesError('IS_DIRECTORY', `Path is a directory: ${resolved.rel}`)
  const name = basename(resolved.abs)
  return { abs: resolved.abs, name, size: fileStat.size, mimeType: guessMimeType(name) }
}

export { log as workspaceFilesLog }

export type { WorkspaceEntry, WorkspaceFileInfo, WorkspaceFileKind }
