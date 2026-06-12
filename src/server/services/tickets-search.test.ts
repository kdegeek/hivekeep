/**
 * Tests for `searchTickets` — the autocomplete endpoint feeder used by the
 * `#` mention popover in the composer.
 *
 * Follows the same mock-drizzle pattern as `tickets-resolve-mentions.test.ts`:
 * we replace drizzle, the schema, and `@/server/db/index` with in-memory
 * arrays so the search behaviour can be exercised without sqlite.
 *
 * Coverage focuses on what's *specific to search*:
 *   - project resolution (id existing / missing)
 *   - numeric vs text query branching
 *   - filtering done tickets when `includeDone: false`
 *   - tickets without a `number` are excluded from results
 *   - empty query returns the most recent tickets (limit honoured)
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { fullMockSchema, fullMockDrizzleOrm, fullMockConfig } from '../../test-helpers'

mock.module('@/server/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }),
}))

mock.module('@/server/sse/index', () => ({ sseManager: { broadcast: () => {} } }))
mock.module('@/server/config', () => ({ config: { ...fullMockConfig } }))
mock.module('@/server/services/tasks', () => ({ spawnTask: async () => ({ id: 'stub' }) }))

interface FakeProjectRow { id: string; slug: string | null; title: string }
interface FakeTicketRow {
  id: string
  projectId: string
  number: number | null
  title: string
  status: string
  updatedAt: number
  createdAt: number
}
interface FakeTicketTagRow { ticketId: string; tagId: string }
interface FakeProjectTagRow { id: string; projectId: string; label: string; color: string }

const fakeProjects: FakeProjectRow[] = []
const fakeTickets: FakeTicketRow[] = []
const fakeTicketTags: FakeTicketTagRow[] = []
const fakeProjectTags: FakeProjectTagRow[] = []

function reset() {
  fakeProjects.length = 0
  fakeTickets.length = 0
  fakeTicketTags.length = 0
  fakeProjectTags.length = 0
}

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
    updatedAt: 'updatedAt',
    createdAt: 'createdAt',
  },
  ticketTags: { __name: 'ticketTags' as const, ticketId: 'ticketId', tagId: 'tagId' },
  projectTags: { __name: 'projectTags' as const, id: 'id', projectId: 'projectId', label: 'label', color: 'color' },
  tasks: { __name: 'tasks' as const },
  agents: { __name: 'agents' as const },
  user: { __name: 'user' as const },
  userProfiles: { __name: 'userProfiles' as const },
}))

// Operators: we record only the bits the SUT actually uses. `like` and
// `sql` template literals get reduced to a function we can call against a
// row to decide whether it passes.
type Op = (row: Record<string, unknown>) => boolean

mock.module('drizzle-orm', () => ({
  ...fullMockDrizzleOrm,
  eq: (col: string, val: unknown): Op => (row) => row[col] === val,
  and: (...ops: Op[]): Op => (row) => ops.every((o) => o(row)),
  or: (...ops: Op[]): Op => (row) => ops.some((o) => o(row)),
  inArray: (col: string, vals: unknown[]): Op => (row) => vals.includes(row[col]),
  // The SUT uses LIKE with `%pattern%` and `pattern%` shapes. We honour those
  // two cases — sufficient to validate the SQL the service emits.
  like: (col: string, pattern: string): Op => {
    // Strip the LIKE escape character that the SUT inserts before % and _
    const cleaned = pattern.replace(/\\(.)/g, '$1')
    const prefix = cleaned.startsWith('%')
    const suffix = cleaned.endsWith('%')
    const body = cleaned.replace(/^%|%$/g, '')
    return (row) => {
      const v = String(row[col] ?? '').toLowerCase()
      const b = body.toLowerCase()
      if (prefix && suffix) return v.includes(b)
      if (suffix) return v.startsWith(b)
      if (prefix) return v.endsWith(b)
      return v === b
    }
  },
  // sql`...` is used twice in the SUT:
  //   - sql`${tickets.status} != 'done'`
  //   - sql`CAST(${tickets.number} AS TEXT) LIKE ${num+'%'}`
  //   - sql`CASE WHEN ${tickets.status} = 'done' THEN 1 ELSE 0 END` (orderBy)
  // We don't need to interpret orderBy — sorting is checked separately if
  // needed. For the WHERE-clause cases we detect the pattern by the embedded
  // values and return an Op accordingly.
  sql: (strings: TemplateStringsArray, ...values: unknown[]): Op => {
    const joined = strings.join('?')
    if (joined.includes("!= 'done'")) {
      return (row) => row.status !== 'done'
    }
    if (joined.includes('CAST(') && joined.includes('AS TEXT')) {
      const pattern = String(values[1] ?? '') // second interpolation = the LIKE string
      const prefix = pattern.replace(/%$/, '')
      return (row) => String(row.number ?? '').startsWith(prefix)
    }
    // OrderBy CASE — not a WHERE filter, accept everything.
    return () => true
  },
  desc: () => ({}),
  asc: () => ({}),
  count: () => ({}),
  ne: () => () => true,
  not: () => () => true,
  isNull: () => () => true,
  isNotNull: () => () => true,
  gte: () => () => true,
  lt: () => () => true,
  max: () => ({}),
}))

mock.module('@/server/db/index', () => {
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
    let _joined: { __name: string }[] = []
    let _op: Op = () => true
    let _limit: number | null = null
    let _offset = 0
    function run() {
      if (!_table) return []
      let data: Record<string, unknown>[]
      if (_table.__name === 'projects') data = fakeProjects as unknown as Record<string, unknown>[]
      else if (_table.__name === 'tickets') data = fakeTickets as unknown as Record<string, unknown>[]
      else if (_table.__name === 'ticketTags') {
        // Join ticketTags + projectTags so the SUT's select() over both works.
        data = fakeTicketTags.map((tt) => {
          const pt = fakeProjectTags.find((p) => p.id === tt.tagId)
          return { ...tt, ...pt }
        })
      } else data = []
      const filtered = data.filter(_op)
      const sliced =
        _limit !== null
          ? filtered.slice(_offset, _offset + _limit)
          : filtered.slice(_offset)
      return project(sliced, cols)
    }
    const chain = {
      from: (t: { __name: string }) => {
        _table = t
        return chain
      },
      innerJoin: (t: { __name: string }) => {
        _joined.push(t)
        return chain
      },
      where: (op: Op) => {
        _op = op
        return chain
      },
      orderBy: () => chain,
      limit: (n: number) => {
        _limit = n
        return chain
      },
      offset: (n: number) => {
        _offset = n
        return chain
      },
      all: () => run(),
      get: () => run()[0] ?? null,
    }
    return chain
  }
  return {
    db: { select: (cols: Record<string, unknown>) => selectChain(cols) },
    sqlite: { run: () => ({}) },
  }
})

let searchTickets: typeof import('@/server/services/tickets')['searchTickets']
let TICKET_SEARCH_MAX_RESULTS: number

beforeEach(async () => {
  reset()
  const mod = await import('@/server/services/tickets')
  searchTickets = mod.searchTickets
  TICKET_SEARCH_MAX_RESULTS = mod.TICKET_SEARCH_MAX_RESULTS
})

const NOW = Date.now()

function seedProject(id: string, slug: string, title: string) {
  fakeProjects.push({ id, slug, title })
}

function seedTicket(opts: Partial<FakeTicketRow> & { id: string; projectId: string; number: number }) {
  fakeTickets.push({
    title: '',
    status: 'todo',
    updatedAt: NOW,
    createdAt: NOW,
    ...opts,
  } as FakeTicketRow)
}

describe('searchTickets', () => {
  it('returns an empty array when the project is unknown', async () => {
    const hits = await searchTickets({ query: '', projectId: 'ghost' })
    expect(hits).toEqual([])
  })

  it('returns all tickets in the project when query is empty', async () => {
    seedProject('p1', 'hivekeep', 'Hivekeep')
    seedTicket({ id: 't1', projectId: 'p1', number: 1, title: 'First' })
    seedTicket({ id: 't2', projectId: 'p1', number: 2, title: 'Second' })

    const hits = await searchTickets({ query: '', projectId: 'p1' })
    expect(hits.map((h) => h.number).sort()).toEqual([1, 2])
    // Projection: project slug and name come through.
    expect(hits[0]!.projectSlug).toBe('hivekeep')
    expect(hits[0]!.projectName).toBe('Hivekeep')
  })

  it('filters by text substring on the title (case-insensitive)', async () => {
    seedProject('p1', 'hivekeep', 'Hivekeep')
    seedTicket({ id: 't1', projectId: 'p1', number: 1, title: 'Login bug' })
    seedTicket({ id: 't2', projectId: 'p1', number: 2, title: 'Logout flow' })
    seedTicket({ id: 't3', projectId: 'p1', number: 3, title: 'Dashboard' })

    const hits = await searchTickets({ query: 'log', projectId: 'p1' })
    const titles = hits.map((h) => h.title).sort()
    expect(titles).toEqual(['Login bug', 'Logout flow'])
  })

  it('matches by number prefix when query is numeric', async () => {
    seedProject('p1', 'hivekeep', 'Hivekeep')
    seedTicket({ id: 't1', projectId: 'p1', number: 1, title: 'one' })
    seedTicket({ id: 't2', projectId: 'p1', number: 10, title: 'ten' })
    seedTicket({ id: 't3', projectId: 'p1', number: 11, title: 'eleven' })
    seedTicket({ id: 't4', projectId: 'p1', number: 2, title: 'two' })

    const hits = await searchTickets({ query: '1', projectId: 'p1' })
    // 1, 10, 11 all start with "1"
    const numbers = hits.map((h) => h.number).sort((a, b) => a - b)
    expect(numbers).toEqual([1, 10, 11])
  })

  it('tolerates a leading `#` in the numeric query', async () => {
    seedProject('p1', 'hivekeep', 'Hivekeep')
    seedTicket({ id: 't1', projectId: 'p1', number: 42, title: 'forty-two' })
    seedTicket({ id: 't2', projectId: 'p1', number: 43, title: 'forty-three' })

    const hits = await searchTickets({ query: '#42', projectId: 'p1' })
    expect(hits.map((h) => h.number)).toEqual([42])
  })

  it('excludes done tickets when includeDone is false', async () => {
    seedProject('p1', 'hivekeep', 'Hivekeep')
    seedTicket({ id: 't1', projectId: 'p1', number: 1, title: 'open', status: 'todo' })
    seedTicket({ id: 't2', projectId: 'p1', number: 2, title: 'done one', status: 'done' })

    const hits = await searchTickets({ query: '', projectId: 'p1', includeDone: false })
    expect(hits.map((h) => h.number)).toEqual([1])
  })

  it('includes done tickets by default', async () => {
    seedProject('p1', 'hivekeep', 'Hivekeep')
    seedTicket({ id: 't1', projectId: 'p1', number: 1, title: 'open', status: 'todo' })
    seedTicket({ id: 't2', projectId: 'p1', number: 2, title: 'done one', status: 'done' })

    const hits = await searchTickets({ query: '', projectId: 'p1' })
    expect(hits.map((h) => h.number).sort()).toEqual([1, 2])
  })

  it('skips tickets without an assigned number (pre-backfill rows)', async () => {
    seedProject('p1', 'hivekeep', 'Hivekeep')
    seedTicket({ id: 't1', projectId: 'p1', number: 1, title: 'has number' })
    fakeTickets.push({
      id: 't2',
      projectId: 'p1',
      number: null,
      title: 'no number',
      status: 'todo',
      updatedAt: NOW,
      createdAt: NOW,
    })

    const hits = await searchTickets({ query: '', projectId: 'p1' })
    expect(hits.map((h) => h.id)).toEqual(['t1'])
  })

  it('caps the result set at TICKET_SEARCH_MAX_RESULTS', async () => {
    seedProject('p1', 'hivekeep', 'Hivekeep')
    for (let i = 1; i <= TICKET_SEARCH_MAX_RESULTS + 5; i++) {
      seedTicket({ id: `t${i}`, projectId: 'p1', number: i, title: `t-${i}` })
    }

    const hits = await searchTickets({ query: '', projectId: 'p1' })
    expect(hits.length).toBe(TICKET_SEARCH_MAX_RESULTS)
  })

  it('honours an explicit limit smaller than the cap', async () => {
    seedProject('p1', 'hivekeep', 'Hivekeep')
    for (let i = 1; i <= 10; i++) {
      seedTicket({ id: `t${i}`, projectId: 'p1', number: i, title: `t-${i}` })
    }

    const hits = await searchTickets({ query: '', projectId: 'p1', limit: 3 })
    expect(hits.length).toBe(3)
  })

  it('returns only tickets from the requested project', async () => {
    seedProject('p1', 'hivekeep', 'Hivekeep')
    seedProject('p2', 'soupcon', 'Soupcon')
    seedTicket({ id: 't1', projectId: 'p1', number: 1, title: 'hivekeep one' })
    seedTicket({ id: 't2', projectId: 'p2', number: 1, title: 'soupcon one' })

    const hits = await searchTickets({ query: '', projectId: 'p1' })
    expect(hits.map((h) => h.title)).toEqual(['hivekeep one'])
  })

  it('attaches the primary tag when one is present', async () => {
    seedProject('p1', 'hivekeep', 'Hivekeep')
    seedTicket({ id: 't1', projectId: 'p1', number: 1, title: 'tagged' })
    fakeProjectTags.push({ id: 'tag1', projectId: 'p1', label: 'bug', color: '#ef4444' })
    fakeTicketTags.push({ ticketId: 't1', tagId: 'tag1' })

    const hits = await searchTickets({ query: '', projectId: 'p1' })
    expect(hits[0]!.primaryTag).toEqual({ id: 'tag1', label: 'bug', color: '#ef4444' })
  })

  it('leaves primaryTag null when the ticket has no tags', async () => {
    seedProject('p1', 'hivekeep', 'Hivekeep')
    seedTicket({ id: 't1', projectId: 'p1', number: 1, title: 'plain' })

    const hits = await searchTickets({ query: '', projectId: 'p1' })
    expect(hits[0]!.primaryTag).toBeNull()
  })
})
