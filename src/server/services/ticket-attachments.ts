import { eq, and, desc, asc, inArray } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { join, extname, basename, resolve } from 'path'
import { mkdir, unlink, rm, stat, copyFile } from 'fs/promises'
import { existsSync } from 'fs'
import { db } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import {
  ticketAttachments,
  tickets,
  agents,
  user,
  userProfiles,
} from '@/server/db/schema'
import { config } from '@/server/config'
import { broadcastTicketUpdated } from '@/server/services/tickets'
import type {
  TicketAttachment,
  TicketAttachmentUploader,
} from '@/shared/types'

const log = createLogger('services:ticket-attachments')

/** Hard cap (bytes) on a single attachment. Reuses `UPLOAD_MAX_FILE_SIZE`
 *  so deployments already tuned for chat-attachment size share the same
 *  ceiling. Override via `TICKET_ATTACHMENT_MAX_SIZE` (MB) if needed. */
const MAX_ATTACHMENT_SIZE =
  Number(process.env.TICKET_ATTACHMENT_MAX_SIZE ?? config.upload.maxFileSizeMb) *
  1024 * 1024

/** Executable extensions blocked from upload — uploading is still possible but
 *  the served Content-Disposition is forced to `attachment` so a browser can
 *  never auto-execute or render them inline. We DO NOT reject these outright
 *  because the user's scope explicitly mentioned "any kind of file". */
const FORCE_DOWNLOAD_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.sh', '.ps1', '.msi', '.com', '.scr',
])

function toMillis(value: Date | number): number {
  return value instanceof Date ? value.getTime() : value
}

function getExtension(filename: string): string {
  const ext = extname(filename)
  return ext ? ext : ''
}

/** Disk directory for a given ticket's attachments. */
export function ticketAttachmentsDir(projectId: string, ticketId: string): string {
  return join(config.upload.dir, 'tickets', projectId, ticketId)
}

/** Build the raw-stream URL exposed by the REST layer. Routes live under
 *  `/api/tickets/:ticketId/attachments/...` to match the existing ticket
 *  router mount point in `app.ts`. */
function buildRawUrl(_projectId: string, ticketId: string, attachmentId: string): string {
  return `/api/tickets/${ticketId}/attachments/${attachmentId}/raw`
}

interface UploaderJoinRow {
  uploadedByUserId: string | null
  uploadedByAgentId: string | null
}

async function resolveUploader(row: UploaderJoinRow): Promise<TicketAttachmentUploader> {
  if (row.uploadedByAgentId) {
    const k = db
      .select({
        id: agents.id,
        name: agents.name,
        avatarPath: agents.avatarPath,
        updatedAt: agents.updatedAt,
      })
      .from(agents)
      .where(eq(agents.id, row.uploadedByAgentId))
      .get()
    if (k) {
      const ext = k.avatarPath ? k.avatarPath.split('.').pop() ?? 'png' : null
      return {
        type: 'agent',
        id: k.id,
        name: k.name,
        avatarUrl: ext
          ? `/api/uploads/agents/${k.id}/avatar.${ext}?v=${toMillis(k.updatedAt)}`
          : null,
      }
    }
    return { type: 'agent', id: row.uploadedByAgentId, name: 'Deleted Agent', avatarUrl: null }
  }
  if (row.uploadedByUserId) {
    const u = db
      .select({
        id: user.id,
        userName: user.name,
        userImage: user.image,
        profileFirstName: userProfiles.firstName,
        profileLastName: userProfiles.lastName,
        profilePseudonym: userProfiles.pseudonym,
      })
      .from(user)
      .leftJoin(userProfiles, eq(userProfiles.userId, user.id))
      .where(eq(user.id, row.uploadedByUserId))
      .get()
    if (u) {
      const name = u.profileFirstName && u.profileLastName
        ? `${u.profileFirstName} ${u.profileLastName}`
        : u.profilePseudonym ?? u.userName
      return { type: 'user', id: u.id, name, avatarUrl: u.userImage ?? null }
    }
    return { type: 'user', id: row.uploadedByUserId, name: 'Deleted user', avatarUrl: null }
  }
  return null
}

async function rowToAttachment(
  row: typeof ticketAttachments.$inferSelect,
  projectId: string,
): Promise<TicketAttachment> {
  return {
    id: row.id,
    ticketId: row.ticketId,
    name: row.originalName,
    mimeType: row.mimeType,
    size: row.size,
    description: row.description,
    uploadedBy: await resolveUploader({
      uploadedByUserId: row.uploadedByUserId,
      uploadedByAgentId: row.uploadedByAgentId,
    }),
    url: buildRawUrl(projectId, row.ticketId, row.id),
    createdAt: toMillis(row.createdAt),
    updatedAt: toMillis(row.updatedAt),
  }
}

async function getTicketProjectId(ticketId: string): Promise<string | null> {
  const row = db
    .select({ projectId: tickets.projectId })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .get()
  return row?.projectId ?? null
}

// ─── List ─────────────────────────────────────────────────────────────────────

export async function listAttachments(ticketId: string): Promise<TicketAttachment[]> {
  const projectId = await getTicketProjectId(ticketId)
  if (!projectId) return []
  const rows = db
    .select()
    .from(ticketAttachments)
    .where(eq(ticketAttachments.ticketId, ticketId))
    .orderBy(asc(ticketAttachments.createdAt))
    .all()
  return Promise.all(rows.map((r) => rowToAttachment(r, projectId)))
}

// ─── Get one ──────────────────────────────────────────────────────────────────

export async function getAttachment(
  attachmentId: string,
): Promise<TicketAttachment | null> {
  const row = db
    .select()
    .from(ticketAttachments)
    .where(eq(ticketAttachments.id, attachmentId))
    .get()
  if (!row) return null
  const projectId = await getTicketProjectId(row.ticketId)
  if (!projectId) return null
  return rowToAttachment(row, projectId)
}

/** Raw-stream variant used by the REST layer. Returns the on-disk path plus
 *  the metadata needed to set the response headers. */
export async function getAttachmentRaw(attachmentId: string): Promise<{
  filePath: string
  originalName: string
  mimeType: string
  size: number
  forceDownload: boolean
} | null> {
  const row = db
    .select()
    .from(ticketAttachments)
    .where(eq(ticketAttachments.id, attachmentId))
    .get()
  if (!row) return null
  if (!existsSync(row.storedPath)) {
    log.error({ attachmentId, path: row.storedPath }, 'Stored attachment missing on disk')
    return null
  }
  const ext = getExtension(row.originalName).toLowerCase()
  return {
    filePath: row.storedPath,
    originalName: row.originalName,
    mimeType: row.mimeType,
    size: row.size,
    forceDownload: FORCE_DOWNLOAD_EXTENSIONS.has(ext),
  }
}

// ─── Create ───────────────────────────────────────────────────────────────────

export interface CreateAttachmentParams {
  ticketId: string
  originalName: string
  buffer: Buffer | ArrayBuffer
  mimeType: string
  description?: string | null
  uploader: { type: 'user'; id: string } | { type: 'agent'; id: string } | null
}

export async function createAttachment(
  params: CreateAttachmentParams,
): Promise<TicketAttachment> {
  const projectId = await getTicketProjectId(params.ticketId)
  if (!projectId) throw new Error('TICKET_NOT_FOUND')

  const size = params.buffer instanceof ArrayBuffer
    ? params.buffer.byteLength
    : params.buffer.length
  if (size === 0) throw new Error('FILE_EMPTY')
  if (size > MAX_ATTACHMENT_SIZE) {
    throw new Error(`FILE_TOO_LARGE: max ${MAX_ATTACHMENT_SIZE} bytes`)
  }

  const id = uuid()
  const ext = getExtension(params.originalName)
  const storedName = `${id}${ext}`
  const dir = ticketAttachmentsDir(projectId, params.ticketId)
  const storedPath = join(dir, storedName)

  await mkdir(dir, { recursive: true })
  await Bun.write(storedPath, params.buffer)

  const now = new Date()
  const uploadedByUserId = params.uploader?.type === 'user' ? params.uploader.id : null
  const uploadedByAgentId = params.uploader?.type === 'agent' ? params.uploader.id : null

  db.insert(ticketAttachments)
    .values({
      id,
      ticketId: params.ticketId,
      originalName: params.originalName,
      storedPath,
      mimeType: params.mimeType || 'application/octet-stream',
      size,
      description: params.description ?? null,
      uploadedByUserId,
      uploadedByAgentId,
      createdAt: now,
      updatedAt: now,
    })
    .run()

  log.info(
    {
      attachmentId: id,
      ticketId: params.ticketId,
      projectId,
      name: params.originalName,
      size,
      mimeType: params.mimeType,
    },
    'Ticket attachment created',
  )

  const row = db
    .select()
    .from(ticketAttachments)
    .where(eq(ticketAttachments.id, id))
    .get()!
  const attachment = await rowToAttachment(row, projectId)

  await broadcastTicketUpdated(params.ticketId)
  return attachment
}

// ─── Create from existing on-disk file (Agent tool path) ────────────────────────

export interface CreateAttachmentFromPathParams {
  ticketId: string
  sourcePath: string
  originalName?: string
  description?: string | null
  uploader: { type: 'user'; id: string } | { type: 'agent'; id: string } | null
}

/**
 * Copy a file already on disk (workspace, /api/uploads/... resolved to a local
 * path, etc.) into the ticket attachments directory. Caller is responsible for
 * authorising the source — this function only sees a resolved absolute path.
 */
export async function createAttachmentFromPath(
  params: CreateAttachmentFromPathParams,
): Promise<TicketAttachment> {
  if (!existsSync(params.sourcePath)) {
    throw new Error('SOURCE_NOT_FOUND')
  }
  const projectId = await getTicketProjectId(params.ticketId)
  if (!projectId) throw new Error('TICKET_NOT_FOUND')

  const stats = await stat(params.sourcePath)
  if (stats.size === 0) throw new Error('FILE_EMPTY')
  if (stats.size > MAX_ATTACHMENT_SIZE) {
    throw new Error(`FILE_TOO_LARGE: max ${MAX_ATTACHMENT_SIZE} bytes`)
  }

  const originalName = params.originalName ?? basename(params.sourcePath)
  const id = uuid()
  const ext = getExtension(originalName)
  const storedName = `${id}${ext}`
  const dir = ticketAttachmentsDir(projectId, params.ticketId)
  const storedPath = join(dir, storedName)
  await mkdir(dir, { recursive: true })
  await copyFile(params.sourcePath, storedPath)

  const mimeType = guessMimeType(originalName)
  const now = new Date()
  const uploadedByUserId = params.uploader?.type === 'user' ? params.uploader.id : null
  const uploadedByAgentId = params.uploader?.type === 'agent' ? params.uploader.id : null

  db.insert(ticketAttachments)
    .values({
      id,
      ticketId: params.ticketId,
      originalName,
      storedPath,
      mimeType,
      size: stats.size,
      description: params.description ?? null,
      uploadedByUserId,
      uploadedByAgentId,
      createdAt: now,
      updatedAt: now,
    })
    .run()

  log.info(
    { attachmentId: id, ticketId: params.ticketId, projectId, name: originalName, size: stats.size },
    'Ticket attachment created from disk path',
  )

  const row = db
    .select()
    .from(ticketAttachments)
    .where(eq(ticketAttachments.id, id))
    .get()!
  const attachment = await rowToAttachment(row, projectId)
  await broadcastTicketUpdated(params.ticketId)
  return attachment
}

// ─── Update (metadata only) ───────────────────────────────────────────────────

export interface UpdateAttachmentParams {
  name?: string
  description?: string | null
}

export async function updateAttachment(
  attachmentId: string,
  params: UpdateAttachmentParams,
): Promise<TicketAttachment | null> {
  const existing = db
    .select()
    .from(ticketAttachments)
    .where(eq(ticketAttachments.id, attachmentId))
    .get()
  if (!existing) return null

  const updates: Partial<typeof ticketAttachments.$inferInsert> = {
    updatedAt: new Date(),
  }
  if (params.name !== undefined && params.name.trim().length > 0) {
    updates.originalName = params.name.trim()
  }
  if (params.description !== undefined) {
    updates.description = params.description
  }

  db.update(ticketAttachments)
    .set(updates)
    .where(eq(ticketAttachments.id, attachmentId))
    .run()

  const updated = await getAttachment(attachmentId)
  if (updated) {
    await broadcastTicketUpdated(existing.ticketId)
  }
  return updated
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteAttachment(attachmentId: string): Promise<boolean> {
  const existing = db
    .select()
    .from(ticketAttachments)
    .where(eq(ticketAttachments.id, attachmentId))
    .get()
  if (!existing) return false

  try {
    if (existsSync(existing.storedPath)) {
      await unlink(existing.storedPath)
    }
  } catch (err) {
    log.warn({ attachmentId, err }, 'Failed to remove attachment file from disk')
  }

  db.delete(ticketAttachments).where(eq(ticketAttachments.id, attachmentId)).run()
  log.info({ attachmentId, ticketId: existing.ticketId }, 'Ticket attachment deleted')
  await broadcastTicketUpdated(existing.ticketId)
  return true
}

/** Bulk-delete every attachment for a ticket and remove its directory. Called
 *  by `deleteTicket()` before the cascade fires so the disk side stays clean. */
export async function purgeAttachmentsForTicket(ticketId: string): Promise<number> {
  const projectId = await getTicketProjectId(ticketId)
  const rows = db
    .select({ id: ticketAttachments.id, storedPath: ticketAttachments.storedPath })
    .from(ticketAttachments)
    .where(eq(ticketAttachments.ticketId, ticketId))
    .all()

  for (const row of rows) {
    try {
      if (existsSync(row.storedPath)) await unlink(row.storedPath)
    } catch {
      // best-effort
    }
  }

  if (projectId) {
    const dir = ticketAttachmentsDir(projectId, ticketId)
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }

  if (rows.length > 0) {
    db.delete(ticketAttachments).where(eq(ticketAttachments.ticketId, ticketId)).run()
    log.info({ ticketId, removed: rows.length }, 'Purged ticket attachments')
  }
  return rows.length
}

// ─── Source resolver (for Agent tools) ─────────────────────────────────────────

/**
 * Resolve a free-form `source` string to a local absolute file path,
 * mirroring the resolver used by `attach_file` so agents can reference the
 * same kinds of sources (workspace path, internal /api/uploads URL, etc).
 *
 *   - `/api/uploads/...`     -> `${dataDir}/uploads/...`
 *   - `/api/file-storage/...` -> `${dataDir}/file-storage/...` (token lookup)
 *   - `https://` / `http://` -> downloaded into a temp buffer (caller decides)
 *   - anything else          -> treated as relative to the agent's workspace
 *
 * Returns `{ kind: 'path', path }` for direct-file sources, or
 * `{ kind: 'url', url }` for remote URLs (caller must `fetch`).
 */
export function resolveAttachmentSource(
  agentId: string,
  source: string,
): { kind: 'path'; path: string } | { kind: 'url'; url: string } | { kind: 'error'; message: string } {
  if (!source || typeof source !== 'string') {
    return { kind: 'error', message: 'source is required' }
  }
  if (source.startsWith('/api/uploads/')) {
    const path = resolve(config.dataDir, source.replace(/^\/api\//, ''))
    if (!existsSync(path)) return { kind: 'error', message: `File not found at ${source}` }
    return { kind: 'path', path }
  }
  if (source.startsWith('/api/file-storage/')) {
    const path = resolve(config.dataDir, source.replace(/^\/api\//, ''))
    if (!existsSync(path)) return { kind: 'error', message: `File not found at ${source}` }
    return { kind: 'path', path }
  }
  if (source.startsWith('https://') || source.startsWith('http://')) {
    return { kind: 'url', url: source }
  }
  // Treat as workspace-relative path.
  const workspaceBase = join(config.workspace.baseDir, agentId)
  const candidate = resolve(workspaceBase, source)
  if (!candidate.startsWith(workspaceBase)) {
    return { kind: 'error', message: 'Path traversal blocked' }
  }
  if (!existsSync(candidate)) {
    return { kind: 'error', message: `File not found in workspace: ${source}` }
  }
  return { kind: 'path', path: candidate }
}

// ─── MIME helpers ────────────────────────────────────────────────────────────

const EXT_TO_MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.yaml': 'application/x-yaml',
  '.yml': 'application/x-yaml',
  '.html': 'text/html',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
}

export function guessMimeType(filename: string): string {
  const ext = getExtension(filename).toLowerCase()
  return EXT_TO_MIME[ext] ?? 'application/octet-stream'
}

/** Best-effort text-decoding for an Agent reading the attachment inline. Returns
 *  `null` when the content is binary or too large for a sane inline read. */
export async function readAttachmentAsText(
  attachmentId: string,
  options: { maxBytes?: number } = {},
): Promise<
  | { kind: 'text'; content: string; truncated: boolean; size: number; mimeType: string; storedPath: string; name: string }
  | { kind: 'binary'; storedPath: string; size: number; mimeType: string; name: string }
  | { kind: 'not-found' }
> {
  const row = db
    .select()
    .from(ticketAttachments)
    .where(eq(ticketAttachments.id, attachmentId))
    .get()
  if (!row) return { kind: 'not-found' }
  if (!existsSync(row.storedPath)) return { kind: 'not-found' }

  const maxBytes = options.maxBytes ?? 200 * 1024
  const textyMimes = [
    'text/',
    'application/json',
    'application/x-yaml',
    'application/xml',
    'application/javascript',
    'application/typescript',
  ]
  const isTexty =
    textyMimes.some((p) => row.mimeType.startsWith(p)) ||
    /\.(txt|md|json|ya?ml|csv|xml|html?|js|ts|tsx|jsx|css|scss|sh|py|rb|go|rs|java|kt|swift|ini|conf|log)$/i.test(row.originalName)

  if (!isTexty) {
    return {
      kind: 'binary',
      storedPath: row.storedPath,
      size: row.size,
      mimeType: row.mimeType,
      name: row.originalName,
    }
  }

  const file = Bun.file(row.storedPath)
  const buf = await file.arrayBuffer()
  const truncated = buf.byteLength > maxBytes
  const slice = truncated ? buf.slice(0, maxBytes) : buf
  const content = new TextDecoder('utf-8', { fatal: false }).decode(slice)
  return {
    kind: 'text',
    content,
    truncated,
    size: row.size,
    mimeType: row.mimeType,
    storedPath: row.storedPath,
    name: row.originalName,
  }
}

/** Re-export for tests that want to inspect raw DB shape via id. */
export async function _getAttachmentRow(attachmentId: string) {
  return db
    .select()
    .from(ticketAttachments)
    .where(eq(ticketAttachments.id, attachmentId))
    .get()
}

/** Re-export for tests / debug. */
export { log as ticketAttachmentsLog }

// Silence unused import warnings for symbols only used by typed selects above.
void desc
void inArray
void and
