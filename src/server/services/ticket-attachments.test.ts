/**
 * Tests for the ticket-attachments service. Mirrors the in-memory SQLite
 * pattern used by ticket-comments.test.ts — full schema, real drizzle
 * queries, mocked logger + SSE.
 */
import { describe, it, expect, mock, beforeAll, beforeEach, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as schema from '@/server/db/schema'

const broadcasted: Array<{ type: string; data: Record<string, unknown> }> = []

mock.module('@/server/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }),
}))
mock.module('@/server/sse/index', () => ({
  sseManager: { broadcast: (e: { type: string; data: Record<string, unknown> }) => broadcasted.push(e) },
}))

// Override the config so attachments land in a temp directory. We splice into
// the REAL config (rather than mocking it) so transitive imports (tasks →
// vault → config.vault.*) keep working. The SUT only reads `dataDir`,
// `upload.*`, and `workspace.baseDir`, so a runtime mutation is enough.
const tmpDataDir = mkdtempSync(join(tmpdir(), 'hivekeep-attachments-test-'))
const { config: realConfig } = await import('@/server/config') as {
  config: {
    dataDir: string
    upload: { dir: string; maxFileSizeMb: number }
    workspace: { baseDir: string }
  }
}
realConfig.dataDir = tmpDataDir
realConfig.upload = { ...realConfig.upload, dir: join(tmpDataDir, 'uploads'), maxFileSizeMb: 50 }
realConfig.workspace = { ...realConfig.workspace, baseDir: join(tmpDataDir, 'workspaces') }

const schemaIsReal = !!(schema as any).ticketAttachments?.id

const sqlite = new Database(':memory:')
sqlite.run('PRAGMA foreign_keys = ON')
const db = schemaIsReal ? drizzle(sqlite, { schema }) : (null as any)

if (schemaIsReal) {
  mock.module('@/server/db/index', () => ({ db, sqlite, initVirtualTables: () => {} }))
}

const ticketAttachmentsMod = schemaIsReal
  ? await import('@/server/services/ticket-attachments')
  : ({} as typeof import('@/server/services/ticket-attachments'))
const {
  createAttachment,
  createAttachmentFromPath,
  listAttachments,
  getAttachment,
  updateAttachment,
  deleteAttachment,
  purgeAttachmentsForTicket,
  resolveAttachmentSource,
  readAttachmentAsText,
} = ticketAttachmentsMod as typeof import('@/server/services/ticket-attachments')

const itMocked = schemaIsReal ? it : it.skip

beforeAll(() => {
  if (!schemaIsReal) return
  sqlite.run(`
    CREATE TABLE user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 0,
      image TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  sqlite.run(`
    CREATE TABLE user_profiles (
      user_id TEXT PRIMARY KEY REFERENCES user(id),
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      pseudonym TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'fr',
      role TEXT NOT NULL DEFAULT 'member',
      agent_order TEXT,
      cron_order TEXT
    )
  `)
  sqlite.run(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      avatar_path TEXT,
      character TEXT NOT NULL,
      expertise TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_id TEXT,
      workspace_path TEXT NOT NULL,
      toolbox_ids TEXT,
      compacting_config TEXT,
      thinking_config TEXT,
      active_project_id TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  sqlite.run(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      github_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  sqlite.run(`
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      number INTEGER,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'backlog',
      position INTEGER NOT NULL DEFAULT 0,
      reporter_user_id TEXT,
      reporter_agent_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  sqlite.run(`
    CREATE TABLE project_tags (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  sqlite.run(`
    CREATE TABLE ticket_tags (
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES project_tags(id) ON DELETE CASCADE,
      PRIMARY KEY (ticket_id, tag_id)
    )
  `)
  sqlite.run(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      parent_agent_id TEXT,
      target_agent_id TEXT,
      ticket_id TEXT,
      description TEXT,
      title TEXT,
      kind TEXT,
      mode TEXT,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      depth INTEGER DEFAULT 0,
      spawn_type TEXT,
      retry_count INTEGER DEFAULT 0,
      schedule_state TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      cron_id TEXT,
      paused_reason TEXT,
      previous_status TEXT,
      paused_at INTEGER,
      tool_preset TEXT,
      kind_origin TEXT,
      request_input_count INTEGER DEFAULT 0,
      inter_agent_request_count INTEGER DEFAULT 0,
      inter_agent_request_chain_id TEXT,
      inter_agent_origin_task_id TEXT,
      thinking_config TEXT,
      effective_thinking TEXT,
      manual_run TEXT,
      todos TEXT
    )
  `)
  sqlite.run(`
    CREATE TABLE ticket_attachments (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      original_name TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      description TEXT,
      uploaded_by_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
      uploaded_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
})

afterAll(() => {
  try {
    rmSync(tmpDataDir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

beforeEach(() => {
  if (!schemaIsReal) return
  sqlite.run('DELETE FROM ticket_attachments')
  sqlite.run('DELETE FROM tasks')
  sqlite.run('DELETE FROM ticket_tags')
  sqlite.run('DELETE FROM project_tags')
  sqlite.run('DELETE FROM tickets')
  sqlite.run('DELETE FROM projects')
  sqlite.run('DELETE FROM agents')
  sqlite.run('DELETE FROM user_profiles')
  sqlite.run('DELETE FROM user')
  broadcasted.length = 0

  const now = Date.now()
  sqlite.run(
    `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
     VALUES ('user-1', 'Alice User', 'alice@example.com', 1, ?, ?)`,
    [now, now],
  )
  sqlite.run(
    `INSERT INTO user_profiles (user_id, first_name, last_name, pseudonym)
     VALUES ('user-1', 'Alice', 'Doe', 'alice')`,
  )
  sqlite.run(
    `INSERT INTO agents (id, slug, name, role, character, expertise, model, workspace_path, created_at, updated_at)
     VALUES ('agent-1', 'k', 'AgentAttach', 'r', 'c', 'e', 'm', '/tmp/agent-1', ?, ?)`,
    [now, now],
  )
  sqlite.run(
    `INSERT INTO projects (id, slug, title, created_at, updated_at)
     VALUES ('proj-1', 'demo', 'Demo', ?, ?)`,
    [now, now],
  )
  sqlite.run(
    `INSERT INTO tickets (id, project_id, number, title, created_at, updated_at)
     VALUES ('ticket-1', 'proj-1', 1, 'Hello', ?, ?)`,
    [now, now],
  )
})

describe('ticket-attachments service', () => {
  itMocked('creates and lists attachments, then broadcasts ticket:updated', async () => {
    const buffer = Buffer.from('hello attachment world', 'utf8')
    const created = await createAttachment({
      ticketId: 'ticket-1',
      originalName: 'note.txt',
      buffer,
      mimeType: 'text/plain',
      description: 'manual note',
      uploader: { type: 'user', id: 'user-1' },
    })

    expect(created.id).toBeTruthy()
    expect(created.name).toBe('note.txt')
    expect(created.size).toBe(buffer.length)
    expect(created.description).toBe('manual note')
    expect(created.uploadedBy).toMatchObject({ type: 'user', id: 'user-1', name: 'Alice Doe' })
    expect(created.url).toContain('/api/tickets/ticket-1/attachments/')
    expect(created.url.endsWith('/raw')).toBe(true)

    const listed = await listAttachments('ticket-1')
    expect(listed).toHaveLength(1)
    expect(listed[0]!.id).toBe(created.id)

    // Disk side: file should exist.
    const row = sqlite.query<{ stored_path: string }, [string]>(
      'SELECT stored_path FROM ticket_attachments WHERE id = ?',
    ).get(created.id)!
    expect(existsSync(row.stored_path)).toBe(true)

    expect(broadcasted.some((e) => e.type === 'ticket:updated')).toBe(true)
  })

  itMocked('rejects empty buffers', async () => {
    await expect(
      createAttachment({
        ticketId: 'ticket-1',
        originalName: 'empty.txt',
        buffer: Buffer.alloc(0),
        mimeType: 'text/plain',
        description: null,
        uploader: { type: 'agent', id: 'agent-1' },
      }),
    ).rejects.toThrow('FILE_EMPTY')
  })

  itMocked('deletes the attachment row and its disk file', async () => {
    const created = await createAttachment({
      ticketId: 'ticket-1',
      originalName: 'gone.txt',
      buffer: Buffer.from('bye', 'utf8'),
      mimeType: 'text/plain',
      description: null,
      uploader: { type: 'user', id: 'user-1' },
    })
    const row = sqlite.query<{ stored_path: string }, [string]>(
      'SELECT stored_path FROM ticket_attachments WHERE id = ?',
    ).get(created.id)!
    expect(existsSync(row.stored_path)).toBe(true)

    const ok = await deleteAttachment(created.id)
    expect(ok).toBe(true)
    expect(existsSync(row.stored_path)).toBe(false)
    expect(await getAttachment(created.id)).toBeNull()
  })

  itMocked('updates name and description in place', async () => {
    const created = await createAttachment({
      ticketId: 'ticket-1',
      originalName: 'before.txt',
      buffer: Buffer.from('x', 'utf8'),
      mimeType: 'text/plain',
      description: null,
      uploader: { type: 'agent', id: 'agent-1' },
    })
    const updated = await updateAttachment(created.id, {
      name: 'after.txt',
      description: 'now with context',
    })
    expect(updated?.name).toBe('after.txt')
    expect(updated?.description).toBe('now with context')
  })

  itMocked('purgeAttachmentsForTicket removes all files for a ticket', async () => {
    await createAttachment({
      ticketId: 'ticket-1',
      originalName: 'a.txt',
      buffer: Buffer.from('a', 'utf8'),
      mimeType: 'text/plain',
      description: null,
      uploader: { type: 'user', id: 'user-1' },
    })
    await createAttachment({
      ticketId: 'ticket-1',
      originalName: 'b.txt',
      buffer: Buffer.from('b', 'utf8'),
      mimeType: 'text/plain',
      description: null,
      uploader: { type: 'user', id: 'user-1' },
    })
    const before = await listAttachments('ticket-1')
    expect(before).toHaveLength(2)
    const removed = await purgeAttachmentsForTicket('ticket-1')
    expect(removed).toBe(2)
    const after = await listAttachments('ticket-1')
    expect(after).toHaveLength(0)
  })

  itMocked('reads small text attachments inline and flags binaries', async () => {
    const text = await createAttachment({
      ticketId: 'ticket-1',
      originalName: 'small.txt',
      buffer: Buffer.from('hello inline', 'utf8'),
      mimeType: 'text/plain',
      description: null,
      uploader: { type: 'user', id: 'user-1' },
    })
    const bin = await createAttachment({
      ticketId: 'ticket-1',
      originalName: 'pic.png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      mimeType: 'image/png',
      description: null,
      uploader: { type: 'user', id: 'user-1' },
    })

    const t = await readAttachmentAsText(text.id)
    expect(t.kind).toBe('text')
    if (t.kind === 'text') {
      expect(t.content).toBe('hello inline')
      expect(t.truncated).toBe(false)
    }

    const b = await readAttachmentAsText(bin.id)
    expect(b.kind).toBe('binary')
  })

  itMocked('createAttachmentFromPath copies a workspace file', async () => {
    const wsDir = join(tmpDataDir, 'workspaces', 'agent-1')
    require('fs').mkdirSync(wsDir, { recursive: true })
    const srcPath = join(wsDir, 'report.csv')
    writeFileSync(srcPath, 'col1,col2\n1,2\n', 'utf8')

    const attachment = await createAttachmentFromPath({
      ticketId: 'ticket-1',
      sourcePath: srcPath,
      originalName: 'report.csv',
      description: 'from workspace',
      uploader: { type: 'agent', id: 'agent-1' },
    })

    expect(attachment.name).toBe('report.csv')
    expect(attachment.size).toBe(readFileSync(srcPath).length)
    const stored = sqlite.query<{ stored_path: string }, [string]>(
      'SELECT stored_path FROM ticket_attachments WHERE id = ?',
    ).get(attachment.id)!
    expect(existsSync(stored.stored_path)).toBe(true)
  })

  itMocked('resolveAttachmentSource accepts workspace paths and rejects traversal', () => {
    const wsDir = join(tmpDataDir, 'workspaces', 'agent-1')
    require('fs').mkdirSync(wsDir, { recursive: true })
    writeFileSync(join(wsDir, 'a.txt'), 'x', 'utf8')

    const ok = resolveAttachmentSource('agent-1', 'a.txt')
    expect(ok.kind).toBe('path')

    const traversal = resolveAttachmentSource('agent-1', '../../etc/passwd')
    expect(traversal.kind).toBe('error')
  })
})
