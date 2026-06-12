/**
 * Tests for `resolveMentions` — the batch ticket reference resolver used by
 * the chat client to turn `#42` / `hivekeep#42` patterns into clickable badges.
 *
 * We mock drizzle-orm, the DB schema and `@/server/db/index` so we can drive
 * the query results from the test. This isolates the resolution logic (dedup,
 * grouping by project, mapping ref → resolution) without spinning up sqlite.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { fullMockSchema, fullMockDrizzleOrm, fullMockConfig } from '../../test-helpers'

// ─── Mocks (must be declared before importing the module under test) ────────

mock.module('@/server/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}))

// `sseManager` is referenced at module load (export); stub it out so we don't
// pull a real SSE implementation.
mock.module('@/server/sse/index', () => ({
  sseManager: { broadcast: () => {} },
}))

// Use the complete shared config: bun's mock.module is global, so an empty
// config here would leak and break other test files that read config fields.
mock.module('@/server/config', () => ({ config: { ...fullMockConfig } }))

mock.module('@/server/services/tasks', () => ({
  spawnTask: async () => ({ id: 'stub' }),
}))

// Simulated DB tables; the mock translates select().from(table).where(...).get/all()
// into reads from these arrays. The chain inspects which table was selected via
// the `from()` argument (we tag tables in fullMockSchema below).
interface FakeProjectRow { id: string; slug: string | null; title: string }
interface FakeTicketRow {
  id: string
  projectId: string
  number: number | null
  title: string
  status: string
}

const fakeProjects: FakeProjectRow[] = []
const fakeTickets: FakeTicketRow[] = []

function reset() {
  fakeProjects.length = 0
  fakeTickets.length = 0
}

// Schema mock: tag each table with a `__name` so the query stub knows what to read.
mock.module('@/server/db/schema', () => ({
  ...fullMockSchema,
  projects: { __name: 'projects' as const, id: 'id', slug: 'slug', title: 'title' },
  tickets: {
    __name: 'tickets' as const,
    id: 'id',
    projectId: 'projectId',
    number: 'number',
    title: 'title',
    status: 'status',
  },
  // Other tables referenced by tickets.ts module imports — empty stubs.
  ticketTags: { __name: 'ticketTags' as const },
  projectTags: { __name: 'projectTags' as const },
  tasks: { __name: 'tasks' as const },
  agents: { __name: 'agents' as const },
  user: { __name: 'user' as const },
  userProfiles: { __name: 'userProfiles' as const },
}))

// Stateful operator builder: operators record the column/value they were given
// so the query mock can interpret WHERE clauses.
type Op =
  | { kind: 'eq'; col: string; val: unknown }
  | { kind: 'and'; ops: Op[] }
  | { kind: 'inArray'; col: string; vals: unknown[] }
  | { kind: 'other' }

mock.module('drizzle-orm', () => ({
  ...fullMockDrizzleOrm,
  eq: (col: string, val: unknown): Op => ({ kind: 'eq', col, val }),
  and: (...ops: Op[]): Op => ({ kind: 'and', ops }),
  inArray: (col: string, vals: unknown[]): Op => ({ kind: 'inArray', col, vals }),
  desc: () => ({}),
  asc: () => ({}),
  count: () => ({}),
  ne: () => ({ kind: 'other' as const }),
  or: () => ({ kind: 'other' as const }),
  not: () => ({ kind: 'other' as const }),
  like: () => ({ kind: 'other' as const }),
  isNull: () => ({ kind: 'other' as const }),
  isNotNull: () => ({ kind: 'other' as const }),
  gte: () => ({ kind: 'other' as const }),
  lt: () => ({ kind: 'other' as const }),
  max: () => ({}),
}))

function matches(row: Record<string, unknown>, op: Op): boolean {
  if (op.kind === 'eq') return row[op.col] === op.val
  if (op.kind === 'and') return op.ops.every((o) => matches(row, o))
  if (op.kind === 'inArray') return op.vals.includes(row[op.col])
  return true
}

mock.module('@/server/db/index', () => {
  // The chain we need to support:
  //   db.select({alias: table.col}).from(table).where(op).get() / .all()
  //
  // The select projection is honored: we map each alias to its source column
  // name (the table column was tagged with a plain string in fullMockSchema
  // overrides, e.g. `projects.title === 'title'`). This mirrors drizzle's
  // SELECT aliasing — `name: projects.title` reads `title` from the row and
  // exposes it as `name` in the result.
  function project(rows: Record<string, unknown>[], cols: Record<string, unknown>) {
    return rows.map((row) => {
      const out: Record<string, unknown> = {}
      for (const [alias, src] of Object.entries(cols)) {
        const key = typeof src === 'string' ? src : alias
        out[alias] = row[key]
      }
      return out
    })
  }
  function selectChain(cols: Record<string, unknown>) {
    let _table: { __name: string } | null = null
    let _op: Op = { kind: 'other' }
    function run() {
      if (!_table) return []
      const data =
        _table.__name === 'projects'
          ? (fakeProjects as unknown as Record<string, unknown>[])
          : _table.__name === 'tickets'
            ? (fakeTickets as unknown as Record<string, unknown>[])
            : []
      const filtered = data.filter((r) => matches(r, _op))
      return project(filtered, cols)
    }
    const chain = {
      from: (t: { __name: string }) => {
        _table = t
        return chain
      },
      where: (op: Op) => {
        _op = op
        return chain
      },
      orderBy: () => chain,
      limit: () => chain,
      offset: () => chain,
      all: () => run(),
      get: () => run()[0] ?? null,
    }
    return chain
  }
  return {
    db: {
      select: (cols: Record<string, unknown>) => selectChain(cols),
    },
    sqlite: { run: () => ({}) },
  }
})

// ─── Now import the module under test ────────────────────────────────────────

let resolveMentions: typeof import('@/server/services/tickets')['resolveMentions']
let RESOLVE_MENTIONS_MAX_REFS: number

beforeEach(async () => {
  reset()
  const mod = await import('@/server/services/tickets')
  resolveMentions = mod.resolveMentions
  RESOLVE_MENTIONS_MAX_REFS = mod.RESOLVE_MENTIONS_MAX_REFS
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('resolveMentions', () => {
  it('returns an empty object when no refs are given', async () => {
    expect(await resolveMentions([])).toEqual({})
  })

  it('flags invalid refs without DB lookups', async () => {
    const out = await resolveMentions(['not a ref', '@@@', ''])
    // empty strings are filtered out before resolution
    expect(out['not a ref']).toEqual({ found: false, reason: 'INVALID_TICKET_REF' })
    expect(out['@@@']).toEqual({ found: false, reason: 'INVALID_TICKET_REF' })
    expect(out['']).toBeUndefined()
  })

  it('resolves a qualified ref via slug + number', async () => {
    fakeProjects.push({ id: 'p1', slug: 'hivekeep', title: 'Hivekeep' })
    fakeTickets.push({ id: 't1', projectId: 'p1', number: 42, title: 'Hello', status: 'in_progress' })

    const out = await resolveMentions(['hivekeep#42'])
    expect(out['hivekeep#42']).toEqual({
      found: true,
      id: 't1',
      number: 42,
      title: 'Hello',
      status: 'in_progress',
      projectId: 'p1',
      projectSlug: 'hivekeep',
      projectName: 'Hivekeep',
    })
  })

  it('returns PROJECT_NOT_FOUND when the slug is unknown', async () => {
    const out = await resolveMentions(['ghost#1'])
    expect(out['ghost#1']).toEqual({ found: false, reason: 'PROJECT_NOT_FOUND' })
  })

  it('returns TICKET_NOT_FOUND when the project exists but the number does not', async () => {
    fakeProjects.push({ id: 'p1', slug: 'hivekeep', title: 'Hivekeep' })
    const out = await resolveMentions(['hivekeep#999'])
    expect(out['hivekeep#999']).toEqual({ found: false, reason: 'TICKET_NOT_FOUND' })
  })

  it('resolves bare refs via the active project context', async () => {
    fakeProjects.push({ id: 'p1', slug: 'hivekeep', title: 'Hivekeep' })
    fakeTickets.push({ id: 't1', projectId: 'p1', number: 7, title: 'Bare', status: 'todo' })

    const out = await resolveMentions(['#7'], { activeProjectId: 'p1' })
    expect(out['#7']).toEqual({
      found: true,
      id: 't1',
      number: 7,
      title: 'Bare',
      status: 'todo',
      projectId: 'p1',
      projectSlug: 'hivekeep',
      projectName: 'Hivekeep',
    })
  })

  it('flags bare refs as NO_ACTIVE_PROJECT when no project context is given', async () => {
    const out = await resolveMentions(['#7'])
    expect(out['#7']).toEqual({ found: false, reason: 'NO_ACTIVE_PROJECT' })
  })

  it('de-dupes identical refs into a single resolution', async () => {
    fakeProjects.push({ id: 'p1', slug: 'hivekeep', title: 'Hivekeep' })
    fakeTickets.push({ id: 't1', projectId: 'p1', number: 42, title: 'Dup', status: 'todo' })

    const out = await resolveMentions(['hivekeep#42', 'hivekeep#42', 'hivekeep#42'])
    // All three keys point to the same logical ref, only one entry remains.
    expect(Object.keys(out)).toEqual(['hivekeep#42'])
    expect(out['hivekeep#42']!.found).toBe(true)
  })

  it('handles a mixed batch with partial successes', async () => {
    fakeProjects.push({ id: 'p1', slug: 'hivekeep', title: 'Hivekeep' })
    fakeProjects.push({ id: 'p2', slug: 'soupcon', title: 'Soupcon' })
    fakeTickets.push({ id: 't1', projectId: 'p1', number: 1, title: 'A', status: 'todo' })
    fakeTickets.push({ id: 't2', projectId: 'p2', number: 5, title: 'B', status: 'done' })

    const out = await resolveMentions(
      ['hivekeep#1', 'soupcon#5', 'hivekeep#999', 'ghost#1', '#1'],
      { activeProjectId: 'p1' },
    )
    expect(out['hivekeep#1']!.found).toBe(true)
    expect(out['soupcon#5']!.found).toBe(true)
    expect(out['hivekeep#999']).toEqual({ found: false, reason: 'TICKET_NOT_FOUND' })
    expect(out['ghost#1']).toEqual({ found: false, reason: 'PROJECT_NOT_FOUND' })
    expect(out['#1']!.found).toBe(true) // bare resolves via activeProjectId
  })

  it('caps to RESOLVE_MENTIONS_MAX_REFS — extras are silently dropped', async () => {
    expect(RESOLVE_MENTIONS_MAX_REFS).toBeGreaterThan(0)
    fakeProjects.push({ id: 'p1', slug: 'hivekeep', title: 'Hivekeep' })
    // Build a batch larger than the cap with unique refs.
    const refs = Array.from({ length: RESOLVE_MENTIONS_MAX_REFS + 5 }, (_, i) => `hivekeep#${i + 1}`)
    const out = await resolveMentions(refs)
    // Only the first MAX entries are processed.
    expect(Object.keys(out).length).toBe(RESOLVE_MENTIONS_MAX_REFS)
    // The dropped entries remain absent.
    expect(out[`hivekeep#${RESOLVE_MENTIONS_MAX_REFS + 1}`]).toBeUndefined()
  })
})
