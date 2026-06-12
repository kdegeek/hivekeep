import os from 'os'
import { spawn, type IPty } from 'bun-pty'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import { sseManager } from '@/server/sse/index'
import type { TerminalSessionDTO } from '@/shared/types'

const log = createLogger('terminal')

/**
 * Admin-only web terminal sessions (Terminal section).
 *
 * tmux-like model: sessions are server-side PTYs scoped to their owner and
 * survive WebSocket disconnects — close the browser, reopen on another device,
 * and reattach to the same shell (scrollback is replayed). A session only dies
 * when its shell exits, when the user closes it from the sessions sidebar, or
 * (if `detachedTtlSec` > 0, off by default) after sitting detached too long.
 * Sessions live in process memory: a server restart kills them.
 *
 * Every lifecycle change emits a `terminal:sessions-changed` SSE event to the
 * owner so all their devices keep their sidebar in sync.
 *
 * bun-pty is used instead of node-pty: node-pty's onData never fires under
 * Bun (its fd-socket trick isn't supported), bun-pty is a Rust/FFI port of
 * the same IPty interface that works natively.
 */

/** Fallback when another test file mocks @/server/config without the terminal
 *  section (Bun's mock.module is global for the whole test run). At runtime
 *  the real config always wins. */
const TERMINAL_DEFAULTS = {
  enabled: true,
  shell: process.env.SHELL ?? '/bin/bash',
  scrollbackKb: 256,
  detachedTtlSec: 0,
  maxSessions: 10,
}

export function getTerminalConfig(): typeof TERMINAL_DEFAULTS {
  return (config as { terminal?: typeof TERMINAL_DEFAULTS }).terminal ?? TERMINAL_DEFAULTS
}

/** Grace period for sessions that were created but never attached (the client
 *  died between the create and the attach) — without it they would leak. */
const ORPHAN_GRACE_MS = 60_000

interface TerminalClient {
  onClosed: () => void
  cols: number
  rows: number
}

export interface TerminalSession {
  id: string
  userId: string
  name: string
  pty: IPty
  createdAt: number
  lastActiveAt: number
  /** Bounded scrollback replayed on (re)attach. */
  scrollback: string
  /** Attached clients, keyed by their sink — output is mirrored to all of
   *  them (tmux-style), and the PTY is sized to the smallest viewer. */
  clients: Map<(data: string) => void, TerminalClient>
  /** True once a client has attached at least once (orphan-grace bookkeeping). */
  everAttached: boolean
  /** Pending kill timer while no client is attached. */
  detachTimer: ReturnType<typeof setTimeout> | null
  exited: boolean
}

const sessions = new Map<string, TerminalSession>()

function toDTO(session: TerminalSession): TerminalSessionDTO {
  return {
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    attached: session.clients.size > 0,
  }
}

/** Mirrored viewing (tmux-style): the PTY is sized to the smallest attached
 *  client so every viewer sees coherent line wrapping. */
function applyClientSizes(session: TerminalSession) {
  if (session.exited || session.clients.size === 0) return
  let cols = Infinity
  let rows = Infinity
  for (const client of session.clients.values()) {
    cols = Math.min(cols, client.cols)
    rows = Math.min(rows, client.rows)
  }
  try {
    session.pty.resize(Math.max(2, cols), Math.max(2, rows))
  } catch (err) {
    log.warn({ err, sessionId: session.id }, 'Terminal resize failed')
  }
}

export function listSessions(userId: string): TerminalSessionDTO[] {
  return [...sessions.values()]
    .filter((s) => s.userId === userId && !s.exited)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(toDTO)
}

function notifySessionsChanged(userId: string) {
  // Optional call: several test files replace @/server/sse/index with partial
  // mocks lacking sendToUser, and mock.module is global to the bun test run.
  sseManager.sendToUser?.(userId, {
    type: 'terminal:sessions-changed',
    data: { sessions: listSessions(userId) },
  })
}

function appendScrollback(session: TerminalSession, data: string) {
  const max = getTerminalConfig().scrollbackKb * 1024
  session.scrollback += data
  if (session.scrollback.length > max) {
    session.scrollback = session.scrollback.slice(session.scrollback.length - max)
  }
}

/** Arm the pending-kill timer for an unattached session. Detached sessions
 *  persist by default (TTL 0); never-attached orphans always get a short grace. */
function armDetachTimer(session: TerminalSession) {
  if (session.detachTimer) clearTimeout(session.detachTimer)
  const ttlMs = session.everAttached ? getTerminalConfig().detachedTtlSec * 1000 : ORPHAN_GRACE_MS
  if (ttlMs <= 0) return
  session.detachTimer = setTimeout(() => {
    log.info({ sessionId: session.id }, 'Detached terminal session expired — killing shell')
    destroySession(session.id)
  }, ttlMs)
}

function nextSessionName(userId: string): string {
  const taken = new Set(
    [...sessions.values()].filter((s) => s.userId === userId && !s.exited).map((s) => s.name),
  )
  for (let n = 1; ; n++) {
    const name = `Session ${n}`
    if (!taken.has(name)) return name
  }
}

export function createSession(userId: string, cols: number, rows: number): TerminalSession {
  const running = [...sessions.values()].filter((s) => !s.exited)
  if (running.length >= getTerminalConfig().maxSessions) {
    throw new Error('TERMINAL_MAX_SESSIONS')
  }

  const id = crypto.randomUUID()
  const pty = spawn(getTerminalConfig().shell, [], {
    name: 'xterm-256color',
    cols: Math.max(2, cols),
    rows: Math.max(2, rows),
    cwd: os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
  })

  const session: TerminalSession = {
    id,
    userId,
    name: nextSessionName(userId),
    pty,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    scrollback: '',
    clients: new Map(),
    everAttached: false,
    detachTimer: null,
    exited: false,
  }
  sessions.set(id, session)

  pty.onData((data) => {
    session.lastActiveAt = Date.now()
    appendScrollback(session, data)
    for (const sink of session.clients.keys()) sink(data)
  })
  pty.onExit(({ exitCode }) => {
    log.info({ sessionId: id, exitCode }, 'Terminal shell exited')
    session.exited = true
    // Let the attached clients render the exit before the session disappears.
    for (const sink of session.clients.keys()) sink(`\r\n[process exited with code ${exitCode}]\r\n`)
    destroySession(id)
  })

  // Unattached until the WS handler claims it — the orphan grace ensures a
  // client that died between create and attach can't leak a shell.
  armDetachTimer(session)

  log.info({ sessionId: id, userId, shell: getTerminalConfig().shell, pid: pty.pid }, 'Terminal session created')
  notifySessionsChanged(userId)
  return session
}

/** Register a client on the session (any number of tabs/devices can view the
 *  same session simultaneously). Returns the scrollback to replay. */
export function attach(
  sessionId: string,
  userId: string,
  sink: (data: string) => void,
  onClosed: () => void,
  cols = 80,
  rows = 24,
): string | null {
  const session = sessions.get(sessionId)
  if (!session || session.exited || session.userId !== userId) return null
  session.clients.set(sink, { onClosed, cols, rows })
  session.everAttached = true
  if (session.detachTimer) {
    clearTimeout(session.detachTimer)
    session.detachTimer = null
  }
  applyClientSizes(session)
  notifySessionsChanged(userId)
  return session.scrollback
}

export function detach(sessionId: string, sink: (data: string) => void) {
  const session = sessions.get(sessionId)
  if (!session) return
  if (!session.clients.delete(sink)) return
  if (session.exited) return
  if (session.clients.size === 0) {
    armDetachTimer(session)
  } else {
    // A small viewer leaving may free the PTY to grow back.
    applyClientSizes(session)
  }
  notifySessionsChanged(session.userId)
}

export function write(sessionId: string, userId: string, data: string) {
  const session = sessions.get(sessionId)
  if (!session || session.exited || session.userId !== userId) return
  session.lastActiveAt = Date.now()
  session.pty.write(data)
}

export function resize(sessionId: string, userId: string, sink: (data: string) => void, cols: number, rows: number) {
  const session = sessions.get(sessionId)
  if (!session || session.exited || session.userId !== userId) return
  const client = session.clients.get(sink)
  if (!client) return
  client.cols = cols
  client.rows = rows
  applyClientSizes(session)
}

export function renameSession(sessionId: string, userId: string, name: string): TerminalSessionDTO | null {
  const session = sessions.get(sessionId)
  if (!session || session.exited || session.userId !== userId) return null
  const trimmed = name.trim().slice(0, 60)
  if (!trimmed) return null
  session.name = trimmed
  notifySessionsChanged(userId)
  return toDTO(session)
}

/** Ownership-checked destroy (sidebar close button / DELETE route). */
export function killSession(sessionId: string, userId: string): boolean {
  const session = sessions.get(sessionId)
  if (!session || session.userId !== userId) return false
  destroySession(sessionId)
  return true
}

export function destroySession(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return
  sessions.delete(sessionId)
  if (session.detachTimer) clearTimeout(session.detachTimer)
  for (const client of session.clients.values()) client.onClosed()
  session.clients.clear()
  if (!session.exited) {
    session.exited = true
    try {
      session.pty.kill()
    } catch (err) {
      log.warn({ err, sessionId }, 'Terminal kill failed')
    }
  }
  notifySessionsChanged(session.userId)
}

export function getSession(sessionId: string, userId: string): TerminalSession | null {
  const session = sessions.get(sessionId)
  if (!session || session.userId !== userId) return null
  return session
}
