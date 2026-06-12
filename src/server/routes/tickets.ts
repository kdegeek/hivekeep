import { Hono } from 'hono'
import {
  getTicket,
  updateTicket,
  deleteTicket,
  startTicketTask,
  startTicketEnrichment,
  resolveMentions,
  searchTickets,
  RESOLVE_MENTIONS_MAX_REFS,
  TICKET_SEARCH_MAX_RESULTS,
} from '@/server/services/tickets'
import {
  listTicketComments,
  createTicketComment,
  updateTicketComment,
  deleteTicketComment,
} from '@/server/services/ticket-comments'
import {
  listAttachments,
  getAttachment,
  getAttachmentRaw,
  createAttachment,
  updateAttachment,
  deleteAttachment,
} from '@/server/services/ticket-attachments'
import { stat } from 'fs/promises'
import { db } from '@/server/db/index'
import { projects } from '@/server/db/schema'
import { eq } from 'drizzle-orm'
import type { AppVariables } from '@/server/app'
import { createLogger } from '@/server/logger'
import { TICKET_STATUSES, THINKING_EFFORTS } from '@/shared/constants'
import type { TicketStatus, AgentThinkingConfig, AgentThinkingEffort } from '@/shared/types'

const TICKET_TASK_VALID_EFFORTS: readonly AgentThinkingEffort[] = THINKING_EFFORTS

const log = createLogger('routes:tickets')

export const ticketRoutes = new Hono<{ Variables: AppVariables }>()

/**
 * Batch-resolve ticket mention refs from free text. Used by the chat client to
 * turn `#42` and `hivekeep#42` patterns into clickable badges in a single round
 * trip per rendered message. Accepts both query strings (`?refs=a,b,c`) and
 * POST bodies (`{ refs: [...] }`) — POST is preferred when N > 10 to avoid
 * URL length limits.
 *
 * Optional `activeProjectId` resolves bare `#N` refs against a specific
 * project. The client is expected to pass the current Agent's active project id.
 */
ticketRoutes.get('/resolve-mentions', async (c) => {
  const refsParam = c.req.query('refs') ?? ''
  const refs = refsParam
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
  if (refs.length === 0) {
    return c.json({ resolutions: {} })
  }
  if (refs.length > RESOLVE_MENTIONS_MAX_REFS) {
    return c.json(
      {
        error: {
          code: 'TOO_MANY_REFS',
          message: `Too many refs (max ${RESOLVE_MENTIONS_MAX_REFS}). Use POST or split the request.`,
        },
      },
      400,
    )
  }
  const activeProjectId = c.req.query('activeProjectId') ?? null
  const resolutions = await resolveMentions(refs, { activeProjectId })
  return c.json({ resolutions })
})

ticketRoutes.post('/resolve-mentions', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const rawRefs = Array.isArray(body.refs) ? body.refs : []
  const refs = rawRefs
    .filter((r: unknown): r is string => typeof r === 'string')
    .map((r: string) => r.trim())
    .filter((r: string) => r.length > 0)
  if (refs.length > RESOLVE_MENTIONS_MAX_REFS) {
    return c.json(
      {
        error: {
          code: 'TOO_MANY_REFS',
          message: `Too many refs (max ${RESOLVE_MENTIONS_MAX_REFS}). Split the request.`,
        },
      },
      400,
    )
  }
  const activeProjectId = typeof body.activeProjectId === 'string' ? body.activeProjectId : null
  const resolutions = await resolveMentions(refs, { activeProjectId })
  return c.json({ resolutions })
})

/**
 * Autocomplete search endpoint for the composer's `#` mention popover.
 *
 *   - `q`            — free-form query (number prefix and/or title substring)
 *   - `projectId`    — UUID of the project to scope the search to
 *   - `projectSlug`  — alternative to projectId; convenient when the client
 *                      has the slug from a `slug#` prefix typed by the user
 *   - `includeDone`  — `0`/`false` to exclude done tickets (default include)
 *   - `limit`        — capped at TICKET_SEARCH_MAX_RESULTS (20)
 *   - `offset`       — pagination
 *
 * Returns `{ hits: TicketSearchHit[] }`. Empty array on missing/unknown project.
 */
ticketRoutes.get('/search', async (c) => {
  const q = c.req.query('q') ?? ''
  let projectId = c.req.query('projectId') ?? ''

  // Resolve projectSlug → projectId if the caller passed a slug instead.
  if (!projectId) {
    const slug = c.req.query('projectSlug') ?? ''
    if (slug) {
      const row = db.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug)).get()
      if (row) projectId = row.id
    }
  }

  if (!projectId) {
    return c.json({ hits: [] })
  }

  const includeDoneRaw = c.req.query('includeDone')
  const includeDone = !(includeDoneRaw === '0' || includeDoneRaw === 'false')

  const rawLimit = Number(c.req.query('limit') ?? TICKET_SEARCH_MAX_RESULTS)
  const limit = Number.isFinite(rawLimit) ? rawLimit : TICKET_SEARCH_MAX_RESULTS
  const rawOffset = Number(c.req.query('offset') ?? 0)
  const offset = Number.isFinite(rawOffset) ? rawOffset : 0

  try {
    const hits = await searchTickets({ query: q, projectId, includeDone, limit, offset })
    return c.json({ hits })
  } catch (err) {
    log.warn({ err }, 'searchTickets failed')
    return c.json({ error: { code: 'INTERNAL', message: 'Search failed' } }, 500)
  }
})

ticketRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const ticket = await getTicket(id)
  if (!ticket) {
    return c.json({ error: { code: 'TICKET_NOT_FOUND', message: 'Ticket not found' } }, 404)
  }
  return c.json({ ticket })
})

ticketRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))

  const update: {
    title?: string
    description?: string
    status?: TicketStatus
    position?: number
    tagIds?: string[]
  } = {}
  if (typeof body.title === 'string') update.title = body.title
  if (typeof body.description === 'string') update.description = body.description
  if (typeof body.status === 'string' && (TICKET_STATUSES as readonly string[]).includes(body.status)) {
    update.status = body.status as TicketStatus
  }
  if (typeof body.position === 'number' && Number.isFinite(body.position)) update.position = body.position
  if (Array.isArray(body.tagIds)) {
    update.tagIds = body.tagIds.filter((t: unknown): t is string => typeof t === 'string')
  }

  try {
    const ticket = await updateTicket(id, update)
    if (!ticket) {
      return c.json({ error: { code: 'TICKET_NOT_FOUND', message: 'Ticket not found' } }, 404)
    }
    return c.json({ ticket })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    log.warn({ err }, 'updateTicket failed')
    return c.json({ error: { code: 'INTERNAL', message: msg } }, 500)
  }
})

ticketRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const ok = await deleteTicket(id)
  if (!ok) {
    return c.json({ error: { code: 'TICKET_NOT_FOUND', message: 'Ticket not found' } }, 404)
  }
  return c.json({ success: true })
})

ticketRoutes.post('/:id/start-task', async (c) => {
  const ticketId = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : ''
  if (!agentId) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'agentId is required' } }, 400)
  }
  const rawRunPrompt = typeof body.runPrompt === 'string' ? body.runPrompt : null
  // Soft length cap mirrored from TICKET_TASK_RUN_PROMPT_MAX so over-long
  // payloads are rejected at the edge with an explicit code rather than being
  // silently truncated server-side.
  if (rawRunPrompt !== null && rawRunPrompt.length > 500) {
    return c.json(
      { error: { code: 'RUN_PROMPT_TOO_LONG', message: 'runPrompt must be 500 characters or fewer' } },
      400,
    )
  }

  // Optional toolbox selection (array of toolbox ids). When omitted the task
  // service falls back to the legacy preset → built-in mapping ('code' for
  // tickets). Validate the shape; unknown ids are tolerated downstream.
  let toolboxIds: string[] | undefined
  if (body.toolboxIds !== undefined) {
    if (!Array.isArray(body.toolboxIds) || body.toolboxIds.some((id: unknown) => typeof id !== 'string')) {
      return c.json(
        { error: { code: 'INVALID_TOOLBOX_IDS', message: 'toolboxIds must be an array of strings' } },
        400,
      )
    }
    toolboxIds = (body.toolboxIds as string[]).map((id) => id.trim()).filter((id) => id.length > 0)
  }

  // Optional per-run model override. model + providerId are coupled: both must
  // be present (and non-empty strings) to apply an override; anything else is
  // treated as "inherit from project default → Agent".
  let model: string | undefined
  let providerId: string | undefined
  if (typeof body.model === 'string' && body.model.trim() && typeof body.providerId === 'string' && body.providerId.trim()) {
    model = body.model.trim()
    providerId = body.providerId.trim()
  }

  // Optional per-run thinking/effort override. Shape mirrors the project /
  // Agent thinking config. Absent → inherit from project default → Agent.
  let thinkingConfig: AgentThinkingConfig | undefined
  if (body.thinkingConfig && typeof body.thinkingConfig === 'object') {
    const cfg = body.thinkingConfig as Record<string, unknown>
    const enabled = cfg.enabled === true
    const effort = typeof cfg.effort === 'string' && (TICKET_TASK_VALID_EFFORTS as readonly string[]).includes(cfg.effort)
      ? (cfg.effort as AgentThinkingEffort)
      : null
    thinkingConfig = { enabled, ...(effort !== null ? { effort } : {}) }
  }

  try {
    const task = await startTicketTask(ticketId, agentId, { runPrompt: rawRunPrompt, toolboxIds, model, providerId, thinkingConfig })
    return c.json({ task }, 201)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg === 'TICKET_NOT_FOUND') {
      return c.json({ error: { code: 'TICKET_NOT_FOUND', message: 'Ticket not found' } }, 404)
    }
    if (msg === 'KIN_NOT_FOUND') {
      return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
    }
    log.warn({ err }, 'startTicketTask failed')
    return c.json({ error: { code: 'INTERNAL', message: msg } }, 500)
  }
})

// ─── Comments ─────────────────────────────────────────────────────────────────

ticketRoutes.get('/:id/comments', async (c) => {
  const ticketId = c.req.param('id')
  const ticket = await getTicket(ticketId)
  if (!ticket) {
    return c.json({ error: { code: 'TICKET_NOT_FOUND', message: 'Ticket not found' } }, 404)
  }
  const rawLimit = Number(c.req.query('limit') ?? 100)
  const limit = Number.isFinite(rawLimit) ? rawLimit : 100
  const rawOffset = Number(c.req.query('offset') ?? 0)
  const offset = Number.isFinite(rawOffset) ? rawOffset : 0
  const result = await listTicketComments(ticketId, { limit, offset })
  return c.json(result)
})

ticketRoutes.post('/:id/comments', async (c) => {
  const ticketId = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const content = typeof body.content === 'string' ? body.content : ''
  if (!content.trim()) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'content is required' } }, 400)
  }
  const sessionUser = c.get('user') as { id: string } | undefined
  if (!sessionUser) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401)
  }
  try {
    const comment = await createTicketComment({
      ticketId,
      author: { type: 'user', id: sessionUser.id },
      content,
    })
    return c.json({ comment }, 201)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg === 'TICKET_NOT_FOUND') {
      return c.json({ error: { code: 'TICKET_NOT_FOUND', message: 'Ticket not found' } }, 404)
    }
    if (msg === 'EMPTY_CONTENT') {
      return c.json({ error: { code: 'INVALID_INPUT', message: 'content is required' } }, 400)
    }
    log.warn({ err }, 'createTicketComment failed')
    return c.json({ error: { code: 'INTERNAL', message: msg } }, 500)
  }
})

ticketRoutes.patch('/:id/comments/:commentId', async (c) => {
  const commentId = c.req.param('commentId')
  const body = await c.req.json().catch(() => ({}))
  const content = typeof body.content === 'string' ? body.content : ''
  if (!content.trim()) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'content is required' } }, 400)
  }
  const sessionUser = c.get('user') as { id: string } | undefined
  if (!sessionUser) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401)
  }
  try {
    const comment = await updateTicketComment(
      commentId,
      { content },
      { type: 'user', id: sessionUser.id },
    )
    if (!comment) {
      return c.json({ error: { code: 'COMMENT_NOT_FOUND', message: 'Comment not found' } }, 404)
    }
    return c.json({ comment })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg === 'FORBIDDEN') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'You cannot edit this comment' } }, 403)
    }
    if (msg === 'EMPTY_CONTENT') {
      return c.json({ error: { code: 'INVALID_INPUT', message: 'content is required' } }, 400)
    }
    log.warn({ err }, 'updateTicketComment failed')
    return c.json({ error: { code: 'INTERNAL', message: msg } }, 500)
  }
})

ticketRoutes.delete('/:id/comments/:commentId', async (c) => {
  const commentId = c.req.param('commentId')
  const sessionUser = c.get('user') as { id: string } | undefined
  if (!sessionUser) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401)
  }
  try {
    const ok = await deleteTicketComment(commentId, { type: 'user', id: sessionUser.id })
    if (!ok) {
      return c.json({ error: { code: 'COMMENT_NOT_FOUND', message: 'Comment not found' } }, 404)
    }
    return c.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg === 'FORBIDDEN') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'You cannot delete this comment' } }, 403)
    }
    log.warn({ err }, 'deleteTicketComment failed')
    return c.json({ error: { code: 'INTERNAL', message: msg } }, 500)
  }
})

// ─── Attachments ──────────────────────────────────────────────────────────────

ticketRoutes.get('/:id/attachments', async (c) => {
  const ticketId = c.req.param('id')
  const ticket = await getTicket(ticketId)
  if (!ticket) {
    return c.json({ error: { code: 'TICKET_NOT_FOUND', message: 'Ticket not found' } }, 404)
  }
  const attachments = await listAttachments(ticketId)
  return c.json({ attachments })
})

ticketRoutes.post('/:id/attachments', async (c) => {
  const ticketId = c.req.param('id')
  const ticket = await getTicket(ticketId)
  if (!ticket) {
    return c.json({ error: { code: 'TICKET_NOT_FOUND', message: 'Ticket not found' } }, 404)
  }
  const sessionUser = c.get('user') as { id: string } | undefined
  if (!sessionUser) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401)
  }

  let formData: FormData
  try {
    formData = await c.req.formData()
  } catch {
    return c.json({ error: { code: 'INVALID_BODY', message: 'Multipart body expected' } }, 400)
  }

  const files = formData.getAll('files').filter((f): f is File => f instanceof File)
  const single = formData.get('file')
  if (single instanceof File) files.push(single)
  if (files.length === 0) {
    return c.json({ error: { code: 'INVALID_FILE', message: 'At least one file is required' } }, 400)
  }

  const description = typeof formData.get('description') === 'string'
    ? (formData.get('description') as string)
    : null

  const created = []
  for (const file of files) {
    try {
      const buffer = Buffer.from(await file.arrayBuffer())
      const attachment = await createAttachment({
        ticketId,
        originalName: file.name,
        buffer,
        mimeType: file.type || 'application/octet-stream',
        description,
        uploader: { type: 'user', id: sessionUser.id },
      })
      created.push(attachment)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed'
      const code = msg.startsWith('FILE_TOO_LARGE')
        ? 'FILE_TOO_LARGE'
        : msg === 'FILE_EMPTY'
          ? 'FILE_EMPTY'
          : 'UPLOAD_ERROR'
      return c.json({ error: { code, message: msg } }, 400)
    }
  }

  return c.json({ attachments: created }, 201)
})

ticketRoutes.get('/:id/attachments/:attachmentId', async (c) => {
  const attachmentId = c.req.param('attachmentId')
  const attachment = await getAttachment(attachmentId)
  if (!attachment || attachment.ticketId !== c.req.param('id')) {
    return c.json({ error: { code: 'ATTACHMENT_NOT_FOUND', message: 'Attachment not found' } }, 404)
  }
  return c.json({ attachment })
})

ticketRoutes.get('/:id/attachments/:attachmentId/raw', async (c) => {
  const attachmentId = c.req.param('attachmentId')
  const ticketId = c.req.param('id')
  const meta = await getAttachment(attachmentId)
  if (!meta || meta.ticketId !== ticketId) {
    return c.json({ error: { code: 'ATTACHMENT_NOT_FOUND', message: 'Attachment not found' } }, 404)
  }
  const raw = await getAttachmentRaw(attachmentId)
  if (!raw) {
    return c.json({ error: { code: 'ATTACHMENT_NOT_FOUND', message: 'File missing on disk' } }, 404)
  }
  const file = Bun.file(raw.filePath)
  let size = raw.size
  try {
    const s = await stat(raw.filePath)
    size = s.size
  } catch {
    // keep DB-recorded size
  }
  const disposition = raw.forceDownload || c.req.query('download') === '1' ? 'attachment' : 'inline'
  // Encode filename to handle non-ASCII characters in headers.
  const encodedName = encodeURIComponent(raw.originalName)
  return new Response(file.stream(), {
    headers: {
      'Content-Type': raw.mimeType || 'application/octet-stream',
      'Content-Length': String(size),
      'Content-Disposition': `${disposition}; filename*=UTF-8''${encodedName}`,
      'Cache-Control': 'private, max-age=0, must-revalidate',
    },
  })
})

ticketRoutes.patch('/:id/attachments/:attachmentId', async (c) => {
  const attachmentId = c.req.param('attachmentId')
  const ticketId = c.req.param('id')
  const existing = await getAttachment(attachmentId)
  if (!existing || existing.ticketId !== ticketId) {
    return c.json({ error: { code: 'ATTACHMENT_NOT_FOUND', message: 'Attachment not found' } }, 404)
  }
  const body = await c.req.json().catch(() => ({})) as { name?: string; description?: string | null }
  const updated = await updateAttachment(attachmentId, {
    name: typeof body.name === 'string' ? body.name : undefined,
    description: body.description === null || typeof body.description === 'string' ? body.description : undefined,
  })
  if (!updated) {
    return c.json({ error: { code: 'ATTACHMENT_NOT_FOUND', message: 'Attachment not found' } }, 404)
  }
  return c.json({ attachment: updated })
})

ticketRoutes.delete('/:id/attachments/:attachmentId', async (c) => {
  const attachmentId = c.req.param('attachmentId')
  const ticketId = c.req.param('id')
  const existing = await getAttachment(attachmentId)
  if (!existing || existing.ticketId !== ticketId) {
    return c.json({ error: { code: 'ATTACHMENT_NOT_FOUND', message: 'Attachment not found' } }, 404)
  }
  const ok = await deleteAttachment(attachmentId)
  if (!ok) {
    return c.json({ error: { code: 'ATTACHMENT_NOT_FOUND', message: 'Attachment not found' } }, 404)
  }
  return c.json({ success: true })
})

ticketRoutes.post('/:id/enrich', async (c) => {
  const ticketId = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : ''
  const focus = typeof body.focus === 'string' && body.focus.trim().length > 0
    ? body.focus.trim()
    : undefined
  if (!agentId) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'agentId is required' } }, 400)
  }

  try {
    const task = await startTicketEnrichment(ticketId, agentId, { focus })
    return c.json({ task }, 201)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg === 'TICKET_NOT_FOUND') {
      return c.json({ error: { code: 'TICKET_NOT_FOUND', message: 'Ticket not found' } }, 404)
    }
    if (msg === 'KIN_NOT_FOUND') {
      return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
    }
    if (msg === 'ENRICHMENT_ALREADY_RUNNING') {
      return c.json(
        {
          error: {
            code: 'ENRICHMENT_ALREADY_RUNNING',
            message: 'An enrichment task is already running on this ticket.',
          },
        },
        409,
      )
    }
    log.warn({ err }, 'startTicketEnrichment failed')
    return c.json({ error: { code: 'INTERNAL', message: msg } }, 500)
  }
})
