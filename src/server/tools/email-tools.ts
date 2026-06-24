/**
 * Native email tools exposed to Agents.
 *
 *  - list_email_accounts — discovery: accounts this Agent may use.
 *  - list_emails         — list a folder (compact summaries).
 *  - read_email          — full message by id.
 *  - search_emails       — structured / raw provider search.
 *  - send_email          — send (or reply in-thread).
 *
 * Every tool resolves an account via `resolveEmailProvider` (explicit slug →
 * default → first valid), which enforces the per-account allow-list against the
 * calling Agent and injects a fresh OAuth access token. Provider-agnostic: the
 * tools never know whether the account is Gmail, IMAP, etc.
 */
import { z } from 'zod'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'
import { tool } from '@/server/tools/tool-helper'
import { resolveEmailProvider, listEmailAccounts } from '@/server/services/email-accounts'
import { createReplyWatchTrigger } from '@/server/services/account-triggers'
import { resolveToolWorkspace } from '@/server/tools/workspace'
import { emitWorkspaceChangedForTool } from '@/server/services/workspace-files'
import { resolveAndValidate } from '@/server/tools/filesystem-tools'
import type { EmailAddress, EmailSearchQuery, OutgoingAttachment } from '@/server/email/types'
import type { ToolExecutionContext } from '@/server/tools/types'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:email')

/** Parse a recipient string ("a@x" or 'Name <a@x>') into a structured address. */
function parseAddr(s: string): EmailAddress {
  const m = s.match(/<([^>]+)>/)
  if (m) {
    const name = s.slice(0, s.indexOf('<')).trim().replace(/^"|"$/g, '')
    return { name: name || undefined, email: m[1]!.trim() }
  }
  return { email: s.trim() }
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

function guessMimeType(filename: string): string {
  return MIME_BY_EXT[extname(filename).slice(1).toLowerCase()] ?? 'application/octet-stream'
}

/** Read the given workspace-relative paths into outgoing attachments, enforcing
 *  the provider's total-size cap. Throws with a clear message on any failure. */
async function readAttachments(
  paths: string[],
  ctx: ToolExecutionContext,
  maxTotalMb: number,
): Promise<OutgoingAttachment[]> {
  const workspace = resolveToolWorkspace(ctx)
  const out: OutgoingAttachment[] = []
  let total = 0
  for (const p of paths) {
    const abs = resolveAndValidate(p, workspace)
    const info = await stat(abs).catch(() => null)
    if (!info || !info.isFile()) throw new Error(`Attachment not found in workspace: ${p}`)
    total += info.size
    if (total > maxTotalMb * 1024 * 1024) {
      throw new Error(`Attachments exceed the ${maxTotalMb} MB limit for this account.`)
    }
    const bytes = await readFile(abs)
    out.push({ filename: basename(p), mimeType: guessMimeType(p), contentBase64: bytes.toString('base64') })
  }
  return out
}

const accountField = z
  .string()
  .optional()
  .describe(
    'Slug of the email account to use. Omit to use the default account. ' +
      'Discover slugs via list_email_accounts.',
  )

function toErr(err: unknown): { error: string } {
  return { error: err instanceof Error ? err.message : String(err) }
}

// ─── list_email_accounts ─────────────────────────────────────────────────────

export const listEmailAccountsTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'List the email accounts this Agent can use (slug, address, type, send mode). ' +
        'Call this when there is more than one account, or to pass the right `account` ' +
        'to the other email tools.',
      inputSchema: z.object({}),
      execute: async () => {
        const accounts = await listEmailAccounts(ctx.agentId)
        return {
          accounts: accounts.map((a) => ({
            slug: a.slug,
            emailAddress: a.emailAddress,
            type: a.type,
            sendMode: a.sendMode,
            isValid: a.isValid,
          })),
        }
      },
    }),
}

// ─── list_emails ─────────────────────────────────────────────────────────────

export const listEmailsTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'List recent emails in a folder (default INBOX). Returns compact summaries ' +
        '(id, from, to, subject, date, snippet, unread). Use read_email for the full ' +
        'body. Use search_emails for richer filtering.',
      inputSchema: z.object({
        account: accountField,
        folder: z.string().optional().describe('Folder/label to list. Default: INBOX.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max messages. Default 20.'),
        query: z.string().optional().describe('Free-text search across subject and body.'),
        unread_only: z.boolean().optional().describe('Only return unread messages.'),
      }),
      execute: async (args) => {
        try {
          const { provider, config, account } = await resolveEmailProvider({ slug: args.account, agentId: ctx.agentId })
          const query: EmailSearchQuery | undefined =
            args.query || args.unread_only ? { text: args.query, unread: args.unread_only } : undefined
          const res = await provider.listMessages({ folder: args.folder, limit: args.limit, query }, config)
          return { account: account.slug, messages: res.messages, nextPageToken: res.nextPageToken }
        } catch (err) {
          return toErr(err)
        }
      },
    }),
}

// ─── read_email ──────────────────────────────────────────────────────────────

export const readEmailTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'Read a full email by id (headers, plain-text body, attachment metadata). ' +
        'Get ids from list_emails or search_emails.',
      inputSchema: z.object({
        account: accountField,
        message_id: z.string().min(1).describe('The email id from list_emails / search_emails.'),
      }),
      execute: async (args) => {
        try {
          const { provider, config, account } = await resolveEmailProvider({ slug: args.account, agentId: ctx.agentId })
          const message = await provider.getMessage(args.message_id, config)
          return { account: account.slug, message }
        } catch (err) {
          return toErr(err)
        }
      },
    }),
}

// ─── search_emails ───────────────────────────────────────────────────────────

export const searchEmailsTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'Search emails with structured filters (from / to / subject / text / unread / ' +
        'has_attachment / after / before), or pass `raw` for the provider-native query ' +
        'syntax (e.g. Gmail operators). Returns compact summaries.',
      inputSchema: z.object({
        account: accountField,
        from: z.string().optional().describe('Sender address or name.'),
        to: z.string().optional().describe('Recipient address or name.'),
        subject: z.string().optional(),
        text: z.string().optional().describe('Free text across subject + body.'),
        unread: z.boolean().optional(),
        has_attachment: z.boolean().optional(),
        after: z.string().optional().describe('Lower date bound (ISO or YYYY-MM-DD).'),
        before: z.string().optional().describe('Upper date bound (ISO or YYYY-MM-DD).'),
        raw: z
          .string()
          .optional()
          .describe('Provider-native query (e.g. Gmail operators). When set, the structured fields are ignored.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max messages. Default 25.'),
      }),
      execute: async (args) => {
        try {
          const { provider, config, account } = await resolveEmailProvider({ slug: args.account, agentId: ctx.agentId })
          const query: EmailSearchQuery = {
            from: args.from,
            to: args.to,
            subject: args.subject,
            text: args.text,
            unread: args.unread,
            hasAttachment: args.has_attachment,
            after: args.after ? Date.parse(args.after) || undefined : undefined,
            before: args.before ? Date.parse(args.before) || undefined : undefined,
            raw: args.raw,
          }
          const res = await provider.listMessages({ query, limit: args.limit ?? 25 }, config)
          return { account: account.slug, messages: res.messages, nextPageToken: res.nextPageToken }
        } catch (err) {
          return toErr(err)
        }
      },
    }),
}

// ─── send_email ──────────────────────────────────────────────────────────────

export const sendEmailTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  destructive: true,
  create: (ctx) =>
    tool({
      description:
        'Send an email from a connected account. Recipients are email addresses ' +
        '(optionally "Name <email>"). Set reply_to_message_id to reply in the same ' +
        'thread. This sends immediately, so be sure of the content and recipients. ' +
        'Set watch_reply to be woken up when a reply lands: it creates a one-shot ' +
        'trigger on the thread, so any reply (whoever sends it) starts a new turn.',
      inputSchema: z.object({
        account: accountField,
        to: z.array(z.string()).min(1).describe('Recipient email addresses.'),
        subject: z.string().describe('Email subject.'),
        body: z.string().describe('Plain-text body.'),
        cc: z.array(z.string()).optional().describe('CC recipients.'),
        bcc: z.array(z.string()).optional().describe('BCC recipients.'),
        html: z.string().optional().describe('Optional HTML body (sent as an alternative part).'),
        attachments: z
          .array(z.string())
          .optional()
          .describe('Workspace-relative file paths to attach (e.g. ["report.pdf"]).'),
        reply_to_message_id: z.string().optional().describe('Reply in-thread to this message id.'),
        watch_reply: z
          .boolean()
          .optional()
          .describe(
            'Wake up when this email gets a reply. Creates a one-shot trigger that ' +
            'starts a new turn on the first reply, regardless of sender: by thread on ' +
            'Gmail/Microsoft, by the In-Reply-To header on IMAP/iCloud.',
          ),
        watch_reply_prompt: z
          .string()
          .optional()
          .describe('Instruction injected when the reply arrives (only used with watch_reply).'),
      }),
      execute: async (args) => {
        try {
          const { provider, config, account, sendMode } = await resolveEmailProvider({
            slug: args.account,
            agentId: ctx.agentId,
          })
          const attachments = args.attachments?.length
            ? await readAttachments(args.attachments, ctx, provider.capabilities.maxAttachmentMb ?? 25)
            : undefined
          const sendParams = {
            to: args.to.map(parseAddr),
            cc: args.cc?.map(parseAddr),
            bcc: args.bcc?.map(parseAddr),
            subject: args.subject,
            body: args.body,
            bodyHtml: args.html,
            attachments,
            replyToMessageId: args.reply_to_message_id,
          }
          // Approval mode (opt-in, per account): queue for human approval instead
          // of sending. The user approves/rejects in the UI; on approve it sends.
          if (sendMode === 'approval') {
            const { createPendingSend } = await import('@/server/services/pending-email-sends')
            const pendingId = await createPendingSend({
              accountId: account.id,
              agentId: ctx.agentId,
              taskId: ctx.taskId,
              params: sendParams,
              // The reply-watch trigger can only be created once the message is
              // actually sent (its threadId is known), so the intent rides along
              // and approvePendingSend sets it up post-send.
              watchReply: args.watch_reply
                ? { prompt: args.watch_reply_prompt }
                : undefined,
            })
            log.info({ agentId: ctx.agentId, account: account.slug, pendingId }, 'send_email queued for approval')
            return {
              account: account.slug,
              queued: true,
              pendingId,
              message:
                `Email queued for human approval (account "${account.slug}" is in approval mode). ` +
                `It will be sent once a human approves it.` +
                (args.watch_reply ? ' A reply-watch trigger will be created once it is sent.' : ''),
            }
          }
          const sent = await provider.sendMessage(sendParams, config)
          log.info({ agentId: ctx.agentId, account: account.slug, recipients: args.to.length }, 'send_email')
          const result: Record<string, unknown> = { account: account.slug, sent: { id: sent.id, threadId: sent.threadId } }
          if (args.watch_reply) {
            try {
              const trigger = await createReplyWatchTrigger({
                accountId: account.id,
                targetAgentId: ctx.agentId,
                threadId: sent.threadId,
                messageId: sent.id,
                subject: args.subject,
                prompt: args.watch_reply_prompt,
              })
              result.replyWatch = trigger
                ? trigger.requiresApproval
                  ? { status: 'pending_approval', triggerId: trigger.id }
                  : { status: 'active', triggerId: trigger.id }
                : { status: 'unsupported', message: 'The provider returned neither a thread id nor a message id for the sent email, so no reply-watch was created.' }
            } catch (err) {
              log.warn({ agentId: ctx.agentId, account: account.slug, err }, 'reply-watch trigger creation failed')
              result.replyWatch = { status: 'failed', message: err instanceof Error ? err.message : String(err) }
            }
          }
          return result
        } catch (err) {
          return toErr(err)
        }
      },
    }),
}

// ─── download_email_attachment ───────────────────────────────────────────────

export const downloadEmailAttachmentTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  create: (ctx) =>
    tool({
      description:
        'Download an email attachment into the workspace so you can read or process ' +
        'it. Get message_id and attachment_id (and the filename) from read_email. ' +
        'Returns the saved workspace-relative path.',
      inputSchema: z.object({
        account: accountField,
        message_id: z.string().min(1).describe('The email id (from read_email).'),
        attachment_id: z.string().min(1).describe('The attachment id (from read_email).'),
        save_as: z
          .string()
          .optional()
          .describe('Workspace-relative path to save to (e.g. "invoice.pdf"). Defaults to the attachment id.'),
      }),
      execute: async (args) => {
        try {
          const { provider, config, account } = await resolveEmailProvider({ slug: args.account, agentId: ctx.agentId })
          if (!provider.getAttachment) {
            return { error: `Account "${account.slug}" does not support downloading attachments.` }
          }
          const { contentBase64 } = await provider.getAttachment(args.message_id, args.attachment_id, config)
          const bytes = Buffer.from(contentBase64, 'base64')
          const workspace = resolveToolWorkspace(ctx)
          const rel = args.save_as?.trim() || `attachment-${args.attachment_id}`
          const abs = resolveAndValidate(rel, workspace)
          await mkdir(dirname(abs), { recursive: true })
          await writeFile(abs, bytes)
          emitWorkspaceChangedForTool(ctx, abs, 'created')
          log.info(
            { agentId: ctx.agentId, account: account.slug, path: rel, bytes: bytes.length },
            'download_email_attachment',
          )
          return { account: account.slug, savedPath: rel, bytes: bytes.length }
        } catch (err) {
          return toErr(err)
        }
      },
    }),
}
