import { tool } from 'ai'
import { z } from 'zod'
import { basename } from 'path'
import { createLogger } from '@/server/logger'
import type { ToolRegistration, ToolExecutionContext } from '@/server/tools/types'
import {
  listAttachments,
  getAttachment,
  createAttachment,
  createAttachmentFromPath,
  updateAttachment,
  deleteAttachment,
  readAttachmentAsText,
  resolveAttachmentSource,
  guessMimeType,
} from '@/server/services/ticket-attachments'
import { resolveTicketRef } from '@/server/services/tickets'
import { db } from '@/server/db/index'
import { kins, ticketAttachments } from '@/server/db/schema'
import { eq } from 'drizzle-orm'

const log = createLogger('tools:ticket-attachment')

function getActiveProjectIdFor(kinId: string): string | null {
  const row = db
    .select({ activeProjectId: kins.activeProjectId })
    .from(kins)
    .where(eq(kins.id, kinId))
    .get()
  return row?.activeProjectId ?? null
}

/** Same gating model as `project-tools.ts`: main agents always, sub-Kins only
 *  when the task is bound to a ticket. */
const mainOrTicketBoundCondition = (ctx: ToolExecutionContext): boolean =>
  !ctx.taskId || !!ctx.ticketId

function serializeAttachmentForKin(att: Awaited<ReturnType<typeof getAttachment>>) {
  if (!att) return null
  return {
    id: att.id,
    ticket_id: att.ticketId,
    name: att.name,
    mime_type: att.mimeType,
    size: att.size,
    description: att.description,
    uploaded_by: att.uploadedBy
      ? { type: att.uploadedBy.type, id: att.uploadedBy.id, name: att.uploadedBy.name }
      : null,
    url: att.url,
    created_at: att.createdAt,
    updated_at: att.updatedAt,
  }
}

export const listTicketAttachmentsTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  condition: mainOrTicketBoundCondition,
  create: (ctx) =>
    tool({
      description:
        'List files attached to a ticket. Each entry includes id, name, mime type, size, ' +
        'description, uploader, and a URL for download. ' +
        'Accepts a UUID, a qualified id like "kinbot#42", or a bare "#42".',
      inputSchema: z.object({ ticket_id: z.string() }),
      execute: async ({ ticket_id }) => {
        const resolved = await resolveTicketRef(ticket_id, {
          activeProjectId: getActiveProjectIdFor(ctx.kinId),
        })
        if (!resolved.ok) return { error: resolved.code, message: resolved.message }
        const attachments = await listAttachments(resolved.ticketId)
        return { attachments: attachments.map(serializeAttachmentForKin) }
      },
    }),
}

export const readTicketAttachmentTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  condition: mainOrTicketBoundCondition,
  create: (ctx) =>
    tool({
      description:
        'Read an attachment on a ticket. For text-like files (txt, json, csv, md, yaml, html, ' +
        'source code) returns the decoded content inline (capped at ~200 KB; use max_bytes ' +
        'to raise/lower). For binary files (images, PDFs, archives), returns the on-disk path ' +
        'so you can call `read_file` on it directly or open it externally. ' +
        'Accepts a UUID, a qualified ticket id like "kinbot#42", or a bare "#42".',
      inputSchema: z.object({
        ticket_id: z.string(),
        attachment_id: z.string(),
        max_bytes: z.number().int().min(1024).max(2_000_000).optional()
          .describe('Cap on inline-decoded text (bytes). Default: 200000.'),
      }),
      execute: async ({ ticket_id, attachment_id, max_bytes }) => {
        const resolved = await resolveTicketRef(ticket_id, {
          activeProjectId: getActiveProjectIdFor(ctx.kinId),
        })
        if (!resolved.ok) return { error: resolved.code, message: resolved.message }

        // Ensure the attachment really belongs to that ticket.
        const row = db
          .select({ ticketId: ticketAttachments.ticketId })
          .from(ticketAttachments)
          .where(eq(ticketAttachments.id, attachment_id))
          .get()
        if (!row || row.ticketId !== resolved.ticketId) {
          return { error: 'ATTACHMENT_NOT_FOUND' }
        }

        const result = await readAttachmentAsText(attachment_id, {
          maxBytes: max_bytes ?? 200_000,
        })
        if (result.kind === 'not-found') return { error: 'ATTACHMENT_NOT_FOUND' }
        if (result.kind === 'text') {
          return {
            kind: 'text',
            name: result.name,
            mime_type: result.mimeType,
            size: result.size,
            truncated: result.truncated,
            stored_path: result.storedPath,
            content: result.content,
          }
        }
        return {
          kind: 'binary',
          name: result.name,
          mime_type: result.mimeType,
          size: result.size,
          stored_path: result.storedPath,
          hint:
            'Binary content (not decoded inline). Call `read_file` on `stored_path` if you need raw bytes, ' +
            'or surface the public URL via list_ticket_attachments to the user.',
        }
      },
    }),
}

export const addTicketAttachmentTool: ToolRegistration = {
  availability: ['main'],
  condition: mainOrTicketBoundCondition,
  create: (ctx) =>
    tool({
      description:
        'Attach a file to a ticket. The `source` accepts: a workspace path (relative to your Kin workspace), ' +
        'an internal URL like `/api/uploads/...` or `/api/file-storage/...`, or an external `https://` URL. ' +
        'Accepts a UUID, a qualified ticket id like "kinbot#42", or a bare "#42".',
      inputSchema: z.object({
        ticket_id: z.string(),
        source: z.string().describe(
          'Workspace path, /api/uploads/... or /api/file-storage/... URL, or https:// URL.',
        ),
        name: z.string().optional().describe('Override the stored filename. Defaults to the source basename.'),
        description: z.string().optional().describe('Optional context for future readers (other kins / users).'),
      }),
      execute: async ({ ticket_id, source, name, description }) => {
        const resolved = await resolveTicketRef(ticket_id, {
          activeProjectId: getActiveProjectIdFor(ctx.kinId),
        })
        if (!resolved.ok) return { error: resolved.code, message: resolved.message }

        const sourceResolved = resolveAttachmentSource(ctx.kinId, source)
        if (sourceResolved.kind === 'error') {
          return { error: 'INVALID_SOURCE', message: sourceResolved.message }
        }

        try {
          if (sourceResolved.kind === 'path') {
            const attachment = await createAttachmentFromPath({
              ticketId: resolved.ticketId,
              sourcePath: sourceResolved.path,
              originalName: name ?? basename(sourceResolved.path),
              description: description ?? null,
              uploader: { type: 'kin', id: ctx.kinId },
            })
            return { attachment: serializeAttachmentForKin(attachment) }
          }
          // URL: download into memory.
          const response = await fetch(sourceResolved.url)
          if (!response.ok) {
            return {
              error: 'DOWNLOAD_FAILED',
              message: `Could not download source: ${response.status} ${response.statusText}`,
            }
          }
          const buffer = Buffer.from(await response.arrayBuffer())
          // Derive a filename: caller override > URL basename > generic.
          let derivedName = name
          if (!derivedName) {
            try {
              const u = new URL(sourceResolved.url)
              const last = u.pathname.split('/').pop()
              if (last && last.length > 0) derivedName = last
            } catch {
              // Ignore — fallback below.
            }
          }
          if (!derivedName) derivedName = 'attachment'
          const mimeType =
            response.headers.get('content-type')?.split(';')[0]?.trim() ?? guessMimeType(derivedName)
          const attachment = await createAttachment({
            ticketId: resolved.ticketId,
            originalName: derivedName,
            buffer,
            mimeType,
            description: description ?? null,
            uploader: { type: 'kin', id: ctx.kinId },
          })
          return { attachment: serializeAttachmentForKin(attachment) }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error'
          log.warn({ err }, 'add_ticket_attachment failed')
          if (msg.startsWith('FILE_TOO_LARGE')) {
            return { error: 'FILE_TOO_LARGE', message: msg }
          }
          if (msg === 'FILE_EMPTY') return { error: 'FILE_EMPTY' }
          return { error: 'UPLOAD_ERROR', message: msg }
        }
      },
    }),
}

export const updateTicketAttachmentTool: ToolRegistration = {
  availability: ['main'],
  condition: mainOrTicketBoundCondition,
  create: (ctx) =>
    tool({
      description:
        'Rename a ticket attachment or update its description. The file content is not touched. ' +
        'Accepts a UUID, a qualified ticket id, or a bare "#42".',
      inputSchema: z.object({
        ticket_id: z.string(),
        attachment_id: z.string(),
        name: z.string().optional(),
        description: z.string().nullable().optional(),
      }),
      execute: async ({ ticket_id, attachment_id, name, description }) => {
        const resolved = await resolveTicketRef(ticket_id, {
          activeProjectId: getActiveProjectIdFor(ctx.kinId),
        })
        if (!resolved.ok) return { error: resolved.code, message: resolved.message }

        const row = db
          .select({ ticketId: ticketAttachments.ticketId })
          .from(ticketAttachments)
          .where(eq(ticketAttachments.id, attachment_id))
          .get()
        if (!row || row.ticketId !== resolved.ticketId) {
          return { error: 'ATTACHMENT_NOT_FOUND' }
        }

        const updated = await updateAttachment(attachment_id, { name, description })
        if (!updated) return { error: 'ATTACHMENT_NOT_FOUND' }
        return { attachment: serializeAttachmentForKin(updated) }
      },
    }),
}

export const deleteTicketAttachmentTool: ToolRegistration = {
  availability: ['main'],
  destructive: true,
  condition: mainOrTicketBoundCondition,
  create: (ctx) =>
    tool({
      description:
        'Permanently delete a ticket attachment. Both the DB row and the file on disk are removed. ' +
        'Accepts a UUID, a qualified ticket id, or a bare "#42".',
      inputSchema: z.object({
        ticket_id: z.string(),
        attachment_id: z.string(),
      }),
      execute: async ({ ticket_id, attachment_id }) => {
        const resolved = await resolveTicketRef(ticket_id, {
          activeProjectId: getActiveProjectIdFor(ctx.kinId),
        })
        if (!resolved.ok) return { error: resolved.code, message: resolved.message }

        const row = db
          .select({ ticketId: ticketAttachments.ticketId })
          .from(ticketAttachments)
          .where(eq(ticketAttachments.id, attachment_id))
          .get()
        if (!row || row.ticketId !== resolved.ticketId) {
          return { error: 'ATTACHMENT_NOT_FOUND' }
        }

        const ok = await deleteAttachment(attachment_id)
        if (!ok) return { error: 'ATTACHMENT_NOT_FOUND' }
        return { success: true, attachment_id }
      },
    }),
}
