import { join, sep, dirname, basename } from 'node:path'
import { constants } from 'node:fs'
import { lstat, realpath, readdir, open, stat } from 'node:fs/promises'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
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
  opts: { forWrite?: boolean } = {},
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
        // canonical already points at the link target — containment check below decides.
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
  opts: { forWrite?: boolean } = {},
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
