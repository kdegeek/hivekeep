import { isAbsolute } from 'node:path'
import { realpathSync, statSync } from 'node:fs'
import { v4 as uuid } from 'uuid'
import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { workspaceFolders } from '@/server/db/schema'
import { isPathBlocked } from '@/server/tools/filesystem-tools'
import { createLogger } from '@/server/logger'
import type { WorkspaceFolderDTO } from '@/shared/types'

const log = createLogger('workspace-folders')

/**
 * User-added arbitrary FS folders surfaced in the Files selector (decision:
 * full edit, visible to every authenticated user). The path is canonicalized
 * with realpath on create and re-validated on every browse via the source
 * resolver, so a folder removed from disk fails cleanly rather than escaping.
 */

export class WorkspaceFolderError extends Error {
  constructor(
    public readonly code: 'INVALID_LABEL' | 'INVALID_PATH' | 'NOT_A_DIRECTORY' | 'PATH_BLOCKED' | 'NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'WorkspaceFolderError'
  }
}

function toDTO(row: typeof workspaceFolders.$inferSelect): WorkspaceFolderDTO {
  return { id: row.id, label: row.label, path: row.path, createdAt: row.createdAt.getTime() }
}

export function listWorkspaceFolders(): WorkspaceFolderDTO[] {
  return db.select().from(workspaceFolders).all().map(toDTO)
}

export function getWorkspaceFolder(id: string): WorkspaceFolderDTO | null {
  const row = db.select().from(workspaceFolders).where(eq(workspaceFolders.id, id)).get()
  return row ? toDTO(row) : null
}

export function createWorkspaceFolder(input: { label: string; path: string; userId?: string | null }): WorkspaceFolderDTO {
  const label = input.label?.trim()
  if (!label) throw new WorkspaceFolderError('INVALID_LABEL', 'Label is required')
  if (typeof input.path !== 'string' || !isAbsolute(input.path)) {
    throw new WorkspaceFolderError('INVALID_PATH', 'Path must be an absolute directory')
  }

  // Canonicalize and validate the directory exists. realpath resolves symlinks
  // so the stored root is stable; the source resolver re-checks on every browse.
  let canonical: string
  try {
    canonical = realpathSync(input.path)
  } catch {
    throw new WorkspaceFolderError('INVALID_PATH', 'Path does not exist')
  }
  if (!statSync(canonical).isDirectory()) {
    throw new WorkspaceFolderError('NOT_A_DIRECTORY', 'Path is not a directory')
  }
  if (isPathBlocked(canonical)) {
    throw new WorkspaceFolderError('PATH_BLOCKED', 'This path is not allowed')
  }

  const row = {
    id: uuid(),
    label,
    path: canonical,
    createdBy: input.userId ?? null,
    createdAt: new Date(),
  }
  db.insert(workspaceFolders).values(row).run()
  log.info({ id: row.id, path: canonical, userId: input.userId }, 'Workspace folder added')
  return toDTO(row)
}

export function deleteWorkspaceFolder(id: string): boolean {
  const existing = db.select().from(workspaceFolders).where(eq(workspaceFolders.id, id)).get()
  if (!existing) return false
  db.delete(workspaceFolders).where(eq(workspaceFolders.id, id)).run()
  log.info({ id }, 'Workspace folder removed')
  return true
}
