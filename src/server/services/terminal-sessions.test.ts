import { describe, it, expect, beforeEach, mock } from 'bun:test'
import type { PersistedTerminalSession, TerminalPersistence } from '@/server/services/terminal-sessions'

// Force the direct-PTY backend so tests are deterministic regardless of whether
// tmux is installed on the host/CI (otherwise sessions would back themselves
// with tmux and shell out to it).
process.env.HIVEKEEP_TERMINAL_TMUX = 'off'

// Mock bun-pty before importing the service: no real shell is spawned, and the
// fake PTY lets tests drive onData/onExit deterministically. (mock.module is
// global for the whole `bun test` process — harmless here, the fake honours
// the same IPty surface the real module exposes.)
interface FakePty {
  pid: number
  cols: number
  rows: number
  written: string[]
  killed: boolean
  emitData: (data: string) => void
  emitExit: (exitCode: number) => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
  onData: (cb: (data: string) => void) => { dispose: () => void }
  onExit: (cb: (e: { exitCode: number }) => void) => { dispose: () => void }
}

const spawned: FakePty[] = []

function makeFakePty(cols: number, rows: number): FakePty {
  let dataCb: ((data: string) => void) | null = null
  let exitCb: ((e: { exitCode: number }) => void) | null = null
  const pty: FakePty = {
    pid: 1000 + spawned.length,
    cols,
    rows,
    written: [],
    killed: false,
    emitData: (data) => dataCb?.(data),
    emitExit: (exitCode) => exitCb?.({ exitCode }),
    write: (data) => pty.written.push(data),
    resize: (c, r) => {
      pty.cols = c
      pty.rows = r
    },
    kill: () => {
      pty.killed = true
    },
    onData: (cb) => {
      dataCb = cb
      return { dispose: () => {} }
    },
    onExit: (cb) => {
      exitCb = cb
      return { dispose: () => {} }
    },
  }
  return pty
}

mock.module('bun-pty', () => ({
  spawn: (_file: string, _args: string[], opts: { cols: number; rows: number }) => {
    const pty = makeFakePty(opts.cols, opts.rows)
    spawned.push(pty)
    return pty
  },
}))

// getTerminalConfig falls back to built-in defaults when another test file
// mocks @/server/config without the terminal section — never reach into
// config.terminal directly here.
const {
  createSession,
  attach,
  detach,
  write,
  resize,
  destroySession,
  getSession,
  getTerminalConfig,
  listSessions,
  renameSession,
  killSession,
  setTerminalPersistence,
  restorePersistedSessions,
} = await import('@/server/services/terminal-sessions')

/** In-memory fake of the injected DB persistence, recording the calls. */
function makeFakeStore(initial: PersistedTerminalSession[] = []): TerminalPersistence & {
  upserts: PersistedTerminalSession[]
  removed: string[]
} {
  const map = new Map(initial.map((r) => [r.id, r]))
  return {
    upserts: [],
    removed: [],
    loadAll() {
      return [...map.values()]
    },
    upsert(row: PersistedTerminalSession) {
      this.upserts.push(row)
      map.set(row.id, row)
    },
    remove(id: string) {
      this.removed.push(id)
      map.delete(id)
    },
  }
}

const terminalConfig = getTerminalConfig()

describe('terminal-sessions', () => {
  beforeEach(() => {
    // Drain any sessions left by a previous test, then reset the spawn log.
    for (const pty of spawned) pty.emitExit(0)
    spawned.length = 0
    // Default to no persistence; tests that exercise it opt in explicitly.
    setTerminalPersistence(null)
  })

  it('creates a session and routes input/output through the PTY', () => {
    const session = createSession('user-1', 100, 40)
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.cols).toBe(100)
    expect(spawned[0]!.rows).toBe(40)

    const received: string[] = []
    const sink = (d: string) => received.push(d)
    const scrollback = attach(session.id, 'user-1', sink, () => {})
    expect(scrollback).toBe('')

    write(session.id, 'user-1', 'ls\r')
    expect(spawned[0]!.written).toEqual(['ls\r'])

    spawned[0]!.emitData('file-a  file-b\r\n')
    expect(received).toEqual(['file-a  file-b\r\n'])

    resize(session.id, 'user-1', sink, 120, 30)
    expect(spawned[0]!.cols).toBe(120)
    expect(spawned[0]!.rows).toBe(30)
  })

  it('replays buffered scrollback on reattach and trims it to the cap', () => {
    const prevKb = terminalConfig.scrollbackKb
    terminalConfig.scrollbackKb = 1 // 1 KB cap for the test
    try {
      const session = createSession('user-1', 80, 24)
      spawned[0]!.emitData('x'.repeat(600))
      spawned[0]!.emitData('y'.repeat(600))

      const scrollback = attach(session.id, 'user-1', () => {}, () => {})
      expect(scrollback).not.toBeNull()
      expect(scrollback!.length).toBe(1024)
      expect(scrollback!.endsWith('y'.repeat(600))).toBe(true)
    } finally {
      terminalConfig.scrollbackKb = prevKb
    }
  })

  it('enforces session ownership', () => {
    const session = createSession('user-1', 80, 24)
    expect(attach(session.id, 'intruder', () => {}, () => {})).toBeNull()
    expect(getSession(session.id, 'intruder')).toBeNull()
    expect(renameSession(session.id, 'intruder', 'mine now')).toBeNull()
    expect(killSession(session.id, 'intruder')).toBe(false)

    write(session.id, 'intruder', 'rm -rf /\r')
    expect(spawned[0]!.written).toEqual([])
  })

  it('lists only the live sessions of the owner, with generated names', () => {
    const a = createSession('user-1', 80, 24)
    const b = createSession('user-1', 80, 24)
    createSession('user-2', 80, 24)

    const mine = listSessions('user-1')
    expect(mine.map((s) => s.id)).toEqual([a.id, b.id])
    expect(mine.map((s) => s.name)).toEqual(['Session 1', 'Session 2'])
    expect(mine.every((s) => !s.attached)).toBe(true)

    attach(a.id, 'user-1', () => {}, () => {})
    expect(listSessions('user-1').find((s) => s.id === a.id)!.attached).toBe(true)

    // A killed session disappears from the list.
    expect(killSession(b.id, 'user-1')).toBe(true)
    expect(listSessions('user-1').map((s) => s.id)).toEqual([a.id])
  })

  it('renames a session (trimmed, length-capped)', () => {
    const session = createSession('user-1', 80, 24)
    const renamed = renameSession(session.id, 'user-1', '  claude code prod  ')
    expect(renamed!.name).toBe('claude code prod')
    expect(renameSession(session.id, 'user-1', '   ')).toBeNull()
    expect(listSessions('user-1')[0]!.name).toBe('claude code prod')
  })

  it('destroys the session and notifies the attached client when the shell exits', () => {
    const session = createSession('user-1', 80, 24)
    let closed = false
    attach(session.id, 'user-1', () => {}, () => {
      closed = true
    })

    spawned[0]!.emitExit(0)
    expect(closed).toBe(true)
    expect(getSession(session.id, 'user-1')).toBeNull()
    expect(attach(session.id, 'user-1', () => {}, () => {})).toBeNull()
  })

  it('kills the PTY on explicit destroy', () => {
    const session = createSession('user-1', 80, 24)
    destroySession(session.id)
    expect(spawned[0]!.killed).toBe(true)
    expect(getSession(session.id, 'user-1')).toBeNull()
  })

  it('mirrors output to every attached client; one leaving does not detach the others', () => {
    const session = createSession('user-1', 80, 24)
    const receivedA: string[] = []
    const receivedB: string[] = []
    const sinkA = (d: string) => receivedA.push(d)
    const sinkB = (d: string) => receivedB.push(d)
    attach(session.id, 'user-1', sinkA, () => {})
    attach(session.id, 'user-1', sinkB, () => {})

    spawned[0]!.emitData('both')
    expect(receivedA).toEqual(['both'])
    expect(receivedB).toEqual(['both'])

    detach(session.id, sinkA)
    spawned[0]!.emitData('only-b')
    expect(receivedA).toEqual(['both'])
    expect(receivedB).toEqual(['both', 'only-b'])
    expect(listSessions('user-1')[0]!.attached).toBe(true)
  })

  it('sizes the PTY to the smallest attached viewer (tmux-style)', () => {
    const session = createSession('user-1', 140, 40)
    const sinkA = () => {}
    const sinkB = () => {}
    attach(session.id, 'user-1', sinkA, () => {}, 140, 40)
    attach(session.id, 'user-1', sinkB, () => {}, 100, 30)
    expect(spawned[0]!.cols).toBe(100)
    expect(spawned[0]!.rows).toBe(30)

    // The bigger viewer shrinking below the other one wins the min.
    resize(session.id, 'user-1', sinkA, 90, 35)
    expect(spawned[0]!.cols).toBe(90)
    expect(spawned[0]!.rows).toBe(30)

    // The small viewer leaving lets the PTY grow back.
    detach(session.id, sinkB)
    expect(spawned[0]!.cols).toBe(90)
    expect(spawned[0]!.rows).toBe(35)
  })

  it('caps the number of concurrent sessions', () => {
    const prevMax = terminalConfig.maxSessions
    terminalConfig.maxSessions = 2
    try {
      createSession('user-1', 80, 24)
      createSession('user-1', 80, 24)
      expect(() => createSession('user-1', 80, 24)).toThrow('TERMINAL_MAX_SESSIONS')
    } finally {
      terminalConfig.maxSessions = prevMax
    }
  })

  it('exposes dormant/persistent in the DTO (live, direct-PTY backend)', () => {
    const session = createSession('user-1', 80, 24)
    const dto = listSessions('user-1').find((s) => s.id === session.id)!
    expect(dto.dormant).toBe(false) // freshly created → has a live shell
    expect(dto.persistent).toBe(false) // tmux forced off → pty backend
  })

  it('strips terminal capability queries (DA/DSR) from the replayed scrollback', () => {
    const session = createSession('user-1', 80, 24)
    // tmux-style startup probes (DA1, DA2, DSR) interleaved with real output.
    spawned[0]!.emitData('hello\x1b[c world\x1b[>0c done\x1b[6n!')
    const replay = attach(session.id, 'user-1', () => {}, () => {})
    // Queries gone, visible content intact — no `1;2c`-style echo on reattach.
    expect(replay).toBe('hello world done!')
  })

  it('persists a session on create and removes its row on destroy', () => {
    const store = makeFakeStore()
    setTerminalPersistence(store)
    const session = createSession('user-1', 80, 24)
    expect(store.upserts.some((r) => r.id === session.id && r.backend === 'pty')).toBe(true)

    destroySession(session.id)
    expect(store.removed).toContain(session.id)
  })

  it('restores persisted sessions as dormant and revives them on attach', () => {
    const store = makeFakeStore([
      {
        id: 'sess-restore',
        userId: 'user-1',
        name: 'Restored',
        createdAt: 1,
        lastActiveAt: 2,
        lastCwd: '/tmp/work',
        scrollback: 'old output',
        backend: 'pty',
        tmuxName: null,
      },
    ])
    setTerminalPersistence(store)

    expect(restorePersistedSessions()).toBe(1)

    const dormant = listSessions('user-1').find((s) => s.id === 'sess-restore')!
    expect(dormant.dormant).toBe(true)
    expect(dormant.persistent).toBe(false)
    expect(dormant.cwd).toBe('/tmp/work') // restored cwd surfaced on the card
    expect(spawned).toHaveLength(0) // no shell spawned while dormant

    // Reattaching revives it: a fresh shell spawns and the saved scrollback replays.
    const scrollback = attach('sess-restore', 'user-1', () => {}, () => {})
    expect(spawned).toHaveLength(1)
    expect(scrollback).toBe('old output')
    expect(listSessions('user-1').find((s) => s.id === 'sess-restore')!.dormant).toBe(false)
  })
})
