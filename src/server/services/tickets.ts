import { eq, and, inArray, max, count, desc } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db, sqlite } from '@/server/db/index'
import { tickets, ticketTags, projectTags, projects, tasks, kins, user, userProfiles } from '@/server/db/schema'
import { sseManager } from '@/server/sse/index'
import { config } from '@/server/config'
import { TICKET_STATUSES } from '@/shared/constants'
import { spawnTask } from '@/server/services/tasks'
import {
  parseTicketRef,
  ticketResolutionMessage,
  type TicketResolutionErrorCode,
} from '@/server/utils/ticket-ref'
import type {
  Ticket,
  TicketStatus,
  TicketSummary,
  TicketTaskSummary,
  ProjectTag,
  RunningKinOnTicket,
  TicketReporter,
} from '@/shared/types'
import type { TicketAssignmentInfo } from '@/server/services/prompt-builder'

function toMillis(value: Date | number): number {
  return value instanceof Date ? value.getTime() : value
}

function isValidStatus(status: string): status is TicketStatus {
  return (TICKET_STATUSES as readonly string[]).includes(status)
}

async function fetchTagsForTicket(ticketId: string): Promise<ProjectTag[]> {
  const rows = db
    .select({ id: projectTags.id, label: projectTags.label, color: projectTags.color })
    .from(ticketTags)
    .innerJoin(projectTags, eq(ticketTags.tagId, projectTags.id))
    .where(eq(ticketTags.ticketId, ticketId))
    .all()
  return rows.map((r) => ({ id: r.id, label: r.label, color: r.color }))
}

async function fetchTagsForTickets(ticketIds: string[]): Promise<Map<string, ProjectTag[]>> {
  if (ticketIds.length === 0) return new Map()
  const rows = db
    .select({
      ticketId: ticketTags.ticketId,
      id: projectTags.id,
      label: projectTags.label,
      color: projectTags.color,
    })
    .from(ticketTags)
    .innerJoin(projectTags, eq(ticketTags.tagId, projectTags.id))
    .where(inArray(ticketTags.ticketId, ticketIds))
    .all()

  const result = new Map<string, ProjectTag[]>()
  for (const row of rows) {
    const list = result.get(row.ticketId) ?? []
    list.push({ id: row.id, label: row.label, color: row.color })
    result.set(row.ticketId, list)
  }
  return result
}

async function fetchTaskCountsForTickets(
  ticketIds: string[],
): Promise<Map<string, { total: number; running: number }>> {
  if (ticketIds.length === 0) return new Map()
  const rows = db
    .select({
      ticketId: tasks.ticketId,
      status: tasks.status,
      n: count(),
    })
    .from(tasks)
    .where(inArray(tasks.ticketId, ticketIds))
    .groupBy(tasks.ticketId, tasks.status)
    .all()

  const result = new Map<string, { total: number; running: number }>()
  for (const row of rows) {
    if (!row.ticketId) continue
    const entry = result.get(row.ticketId) ?? { total: 0, running: 0 }
    entry.total += Number(row.n)
    if (row.status === 'pending' || row.status === 'in_progress' || row.status === 'queued') {
      entry.running += Number(row.n)
    }
    result.set(row.ticketId, entry)
  }
  return result
}

/** For each ticket, fetch the Kins currently executing a task on it (one entry per running task). */
async function fetchRunningKinsForTickets(
  ticketIds: string[],
): Promise<Map<string, RunningKinOnTicket[]>> {
  if (ticketIds.length === 0) return new Map()
  const rows = db
    .select({
      ticketId: tasks.ticketId,
      taskId: tasks.id,
      kinId: kins.id,
      kinName: kins.name,
      kinSlug: kins.slug,
      avatarPath: kins.avatarPath,
      avatarUpdatedAt: kins.updatedAt,
    })
    .from(tasks)
    .innerJoin(kins, eq(tasks.parentKinId, kins.id))
    .where(
      and(
        inArray(tasks.ticketId, ticketIds),
        inArray(tasks.status, ['queued', 'pending', 'in_progress']),
      ),
    )
    .all()

  const result = new Map<string, RunningKinOnTicket[]>()
  for (const row of rows) {
    if (!row.ticketId) continue
    const list = result.get(row.ticketId) ?? []
    list.push({
      kinId: row.kinId,
      kinName: row.kinName,
      kinSlug: row.kinSlug,
      avatarUrl: row.avatarPath
        ? `/api/uploads/kins/${row.kinId}/avatar.${row.avatarPath.split('.').pop() ?? 'png'}?v=${toMillis(row.avatarUpdatedAt)}`
        : null,
      taskId: row.taskId,
    })
    result.set(row.ticketId, list)
  }
  return result
}

/** Resolve a reporter (user or kin) into the public-facing shape. Null if neither set. */
async function fetchReporterForTicket(
  reporterUserId: string | null,
  reporterKinId: string | null,
): Promise<TicketReporter | null> {
  if (reporterKinId) {
    const k = db
      .select({ id: kins.id, slug: kins.slug, name: kins.name, avatarPath: kins.avatarPath, updatedAt: kins.updatedAt })
      .from(kins)
      .where(eq(kins.id, reporterKinId))
      .get()
    if (k) {
      return {
        type: 'kin',
        id: k.id,
        slug: k.slug,
        name: k.name,
        avatarUrl: k.avatarPath
          ? `/api/uploads/kins/${k.id}/avatar.${k.avatarPath.split('.').pop() ?? 'png'}?v=${toMillis(k.updatedAt)}`
          : null,
      }
    }
  }
  if (reporterUserId) {
    const row = db
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
      .where(eq(user.id, reporterUserId))
      .get()
    if (row) {
      const fullName = row.profileFirstName && row.profileLastName
        ? `${row.profileFirstName} ${row.profileLastName}`
        : row.profilePseudonym ?? row.userName
      return {
        type: 'user',
        id: row.id,
        name: fullName,
        avatarUrl: row.userImage ?? null,
      }
    }
  }
  return null
}

async function rowToTicketSummary(
  row: typeof tickets.$inferSelect,
  tags: ProjectTag[],
  taskCounts: { total: number; running: number },
  runningKins: RunningKinOnTicket[] = [],
  reporter: TicketReporter | null = null,
): Promise<TicketSummary> {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number ?? null,
    title: row.title,
    description: row.description,
    status: row.status as TicketStatus,
    position: row.position,
    tags,
    taskCount: taskCounts.total,
    runningTaskCount: taskCounts.running,
    runningKins,
    reporter,
    createdAt: toMillis(row.createdAt),
    updatedAt: toMillis(row.updatedAt),
  }
}

// ─── Reference resolution (UUID / slug#N / #N) ────────────────────────────────

/** Result of resolving a ticket reference. On success, `ticketId` is the UUID
 *  callers can pass to any of the existing UUID-keyed service functions. */
export type ResolveTicketRefResult =
  | { ok: true; ticketId: string }
  | { ok: false; code: TicketResolutionErrorCode; message: string }

/** Resolve a free-form ticket reference (UUID, `slug#N`, or bare `#N` / `N`)
 *  to a ticket UUID using the database.
 *
 *  - UUID: direct lookup.
 *  - `slug#N`: look up the project by slug, then the ticket by (project, number).
 *  - bare `#N`/`N`: requires an `activeProjectId` argument. Resolved against
 *    that project's tickets table.
 *
 *  All failure modes return a structured `{ code, message }` for tools to
 *  surface — never throws on a missing project/ticket. */
export async function resolveTicketRef(
  raw: string,
  ctx: { activeProjectId?: string | null } = {},
): Promise<ResolveTicketRefResult> {
  const parsed = parseTicketRef(raw)
  if (parsed.kind === 'invalid') {
    return {
      ok: false,
      code: 'INVALID_TICKET_REF',
      message: ticketResolutionMessage('INVALID_TICKET_REF', { raw: parsed.raw }),
    }
  }

  if (parsed.kind === 'uuid') {
    const row = db.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, parsed.id)).get()
    if (!row) {
      return {
        ok: false,
        code: 'TICKET_NOT_FOUND',
        message: ticketResolutionMessage('TICKET_NOT_FOUND'),
      }
    }
    return { ok: true, ticketId: row.id }
  }

  if (parsed.kind === 'qualified') {
    const project = db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.slug, parsed.slug))
      .get()
    if (!project) {
      return {
        ok: false,
        code: 'PROJECT_NOT_FOUND',
        message: ticketResolutionMessage('PROJECT_NOT_FOUND', { slug: parsed.slug }),
      }
    }
    const ticket = db
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.projectId, project.id), eq(tickets.number, parsed.number)))
      .get()
    if (!ticket) {
      return {
        ok: false,
        code: 'TICKET_NOT_FOUND',
        message: ticketResolutionMessage('TICKET_NOT_FOUND', {
          slug: parsed.slug,
          number: parsed.number,
        }),
      }
    }
    return { ok: true, ticketId: ticket.id }
  }

  // Bare number: needs an active project context.
  if (!ctx.activeProjectId) {
    return {
      ok: false,
      code: 'NO_ACTIVE_PROJECT',
      message: ticketResolutionMessage('NO_ACTIVE_PROJECT'),
    }
  }
  const project = db
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, ctx.activeProjectId))
    .get()
  if (!project) {
    return {
      ok: false,
      code: 'PROJECT_NOT_FOUND',
      message: ticketResolutionMessage('PROJECT_NOT_FOUND', { slug: '' }),
    }
  }
  const ticket = db
    .select({ id: tickets.id })
    .from(tickets)
    .where(and(eq(tickets.projectId, project.id), eq(tickets.number, parsed.number)))
    .get()
  if (!ticket) {
    return {
      ok: false,
      code: 'TICKET_NOT_FOUND',
      message: ticketResolutionMessage('TICKET_NOT_FOUND', {
        slug: project.slug ?? undefined,
        number: parsed.number,
      }),
    }
  }
  return { ok: true, ticketId: ticket.id }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ListTicketsFilters {
  status?: TicketStatus
  tagId?: string
  limit?: number
  offset?: number
}

export async function listTickets(
  projectId: string,
  filters: ListTicketsFilters = {},
): Promise<{ tickets: TicketSummary[]; hasMore: boolean }> {
  const limit = filters.limit ?? 100
  const offset = filters.offset ?? 0

  const whereClauses = [eq(tickets.projectId, projectId)]
  if (filters.status) whereClauses.push(eq(tickets.status, filters.status))

  let query
  if (filters.tagId) {
    // Join through ticket_tags
    const ticketIds = db
      .select({ ticketId: ticketTags.ticketId })
      .from(ticketTags)
      .where(eq(ticketTags.tagId, filters.tagId))
      .all()
      .map((r) => r.ticketId)
    if (ticketIds.length === 0) return { tickets: [], hasMore: false }
    whereClauses.push(inArray(tickets.id, ticketIds))
  }

  const rows = db
    .select()
    .from(tickets)
    .where(and(...whereClauses))
    .orderBy(tickets.status, tickets.position)
    .limit(limit + 1)
    .offset(offset)
    .all()

  const hasMore = rows.length > limit
  const slice = hasMore ? rows.slice(0, limit) : rows

  const ids = slice.map((r) => r.id)
  const [tagsByTicket, taskCountsByTicket, runningKinsByTicket] = await Promise.all([
    fetchTagsForTickets(ids),
    fetchTaskCountsForTickets(ids),
    fetchRunningKinsForTickets(ids),
  ])

  const items = await Promise.all(
    slice.map(async (row) =>
      rowToTicketSummary(
        row,
        tagsByTicket.get(row.id) ?? [],
        taskCountsByTicket.get(row.id) ?? { total: 0, running: 0 },
        runningKinsByTicket.get(row.id) ?? [],
        await fetchReporterForTicket(row.reporterUserId, row.reporterKinId),
      ),
    ),
  )

  return { tickets: items, hasMore }
}

export async function getTicket(ticketId: string): Promise<Ticket | null> {
  const row = db.select().from(tickets).where(eq(tickets.id, ticketId)).get()
  if (!row) return null

  const [tags, taskRows] = await Promise.all([
    fetchTagsForTicket(ticketId),
    db
      .select({
        id: tasks.id,
        parentKinId: tasks.parentKinId,
        parentKinName: kins.name,
        status: tasks.status,
        mode: tasks.mode,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .innerJoin(kins, eq(tasks.parentKinId, kins.id))
      .where(eq(tasks.ticketId, ticketId))
      .orderBy(desc(tasks.createdAt))
      .all(),
  ])

  const [taskCountsMap, runningKinsMap] = await Promise.all([
    fetchTaskCountsForTickets([ticketId]),
    fetchRunningKinsForTickets([ticketId]),
  ])
  const counts = taskCountsMap.get(ticketId) ?? { total: 0, running: 0 }
  const runningKins = runningKinsMap.get(ticketId) ?? []
  const reporter = await fetchReporterForTicket(row.reporterUserId, row.reporterKinId)

  const ticketTasks: TicketTaskSummary[] = taskRows.map((t) => ({
    id: t.id,
    parentKinId: t.parentKinId,
    parentKinName: t.parentKinName,
    status: t.status as TicketTaskSummary['status'],
    mode: t.mode as TicketTaskSummary['mode'],
    createdAt: toMillis(t.createdAt),
    updatedAt: toMillis(t.updatedAt),
  }))

  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number ?? null,
    title: row.title,
    description: row.description,
    status: row.status as TicketStatus,
    position: row.position,
    tags,
    taskCount: counts.total,
    runningTaskCount: counts.running,
    runningKins,
    reporter,
    tasks: ticketTasks,
    createdAt: toMillis(row.createdAt),
    updatedAt: toMillis(row.updatedAt),
  }
}

async function computeNextPositionInColumn(projectId: string, status: TicketStatus): Promise<number> {
  const row = db
    .select({ maxPos: max(tickets.position) })
    .from(tickets)
    .where(and(eq(tickets.projectId, projectId), eq(tickets.status, status)))
    .get()
  const current = row?.maxPos ?? 0
  return current + config.projects.kanbanPositionStep
}

async function setTicketTags(ticketId: string, tagIds: string[]): Promise<void> {
  // Replace the set entirely (PUT-like semantics)
  db.delete(ticketTags).where(eq(ticketTags.ticketId, ticketId)).run()
  if (tagIds.length === 0) return

  // Validate tags belong to the same project as the ticket
  const ticket = db.select({ projectId: tickets.projectId }).from(tickets).where(eq(tickets.id, ticketId)).get()
  if (!ticket) throw new Error('TICKET_NOT_FOUND')

  const validTags = db
    .select({ id: projectTags.id })
    .from(projectTags)
    .where(and(eq(projectTags.projectId, ticket.projectId), inArray(projectTags.id, tagIds)))
    .all()
  const validIds = new Set(validTags.map((t) => t.id))

  for (const tagId of tagIds) {
    if (!validIds.has(tagId)) continue // Silently skip invalid tags (cross-project or non-existent)
    db.insert(ticketTags)
      .values({ ticketId, tagId })
      .onConflictDoNothing()
      .run()
  }
}

export interface CreateTicketInput {
  projectId: string
  title: string
  description?: string
  status?: TicketStatus
  tagIds?: string[]
  /** Who's creating this ticket — set exactly one (or neither for system seeds). */
  reporter?: { type: 'user'; id: string } | { type: 'kin'; id: string } | null
}

export async function createTicket(input: CreateTicketInput): Promise<TicketSummary> {
  const project = db.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).get()
  if (!project) throw new Error('PROJECT_NOT_FOUND')

  const status = input.status ?? 'backlog'
  if (!isValidStatus(status)) throw new Error('INVALID_STATUS')

  const id = uuid()
  const now = new Date()
  const position = await computeNextPositionInColumn(input.projectId, status)

  const reporterUserId = input.reporter?.type === 'user' ? input.reporter.id : null
  const reporterKinId = input.reporter?.type === 'kin' ? input.reporter.id : null

  // Allocate the per-project monotonic number atomically.
  // SQLite serializes writers so MAX(...)+1 inside a single tx is race-safe;
  // the unique index (project_id, number) is the ultimate safeguard.
  let allocatedNumber = 0
  const txn = sqlite.transaction(() => {
    const maxRow = sqlite
      .query<{ n: number | null }, [string]>(
        'SELECT MAX(number) as n FROM tickets WHERE project_id = ?',
      )
      .get(input.projectId)
    allocatedNumber = (maxRow?.n ?? 0) + 1

    db.insert(tickets)
      .values({
        id,
        projectId: input.projectId,
        number: allocatedNumber,
        title: input.title,
        description: input.description ?? '',
        status,
        position,
        reporterUserId,
        reporterKinId,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })
  txn()

  if (input.tagIds && input.tagIds.length > 0) {
    await setTicketTags(id, input.tagIds)
  }

  const tags = await fetchTagsForTicket(id)
  const reporter = await fetchReporterForTicket(reporterUserId, reporterKinId)
  const summary: TicketSummary = {
    id,
    projectId: input.projectId,
    number: allocatedNumber,
    title: input.title,
    description: input.description ?? '',
    status,
    position,
    tags,
    taskCount: 0,
    runningTaskCount: 0,
    runningKins: [],
    reporter,
    createdAt: now.getTime(),
    updatedAt: now.getTime(),
  }

  sseManager.broadcast({
    type: 'ticket:created',
    data: { ticket: summary },
  })

  return summary
}

export interface UpdateTicketInput {
  title?: string
  description?: string
  status?: TicketStatus
  position?: number
  tagIds?: string[]
}

export async function updateTicket(
  ticketId: string,
  input: UpdateTicketInput,
): Promise<TicketSummary | null> {
  const existing = db.select().from(tickets).where(eq(tickets.id, ticketId)).get()
  if (!existing) return null

  const update: Partial<typeof tickets.$inferInsert> = { updatedAt: new Date() }
  if (input.title !== undefined) update.title = input.title
  if (input.description !== undefined) update.description = input.description

  let newStatus: TicketStatus = existing.status as TicketStatus
  if (input.status !== undefined) {
    if (!isValidStatus(input.status)) throw new Error('INVALID_STATUS')
    newStatus = input.status
    update.status = input.status
  }

  if (input.position !== undefined) {
    update.position = input.position
  } else if (input.status !== undefined && input.status !== existing.status) {
    // Status changed without explicit position → place at top of new column
    update.position = await computeNextPositionInColumn(existing.projectId, newStatus)
  }

  db.update(tickets).set(update).where(eq(tickets.id, ticketId)).run()

  if (input.tagIds !== undefined) {
    await setTicketTags(ticketId, input.tagIds)
  }

  const refreshed = db.select().from(tickets).where(eq(tickets.id, ticketId)).get()
  if (!refreshed) return null

  const tags = await fetchTagsForTicket(ticketId)
  const [taskCountsMap, runningKinsMap] = await Promise.all([
    fetchTaskCountsForTickets([ticketId]),
    fetchRunningKinsForTickets([ticketId]),
  ])
  const counts = taskCountsMap.get(ticketId) ?? { total: 0, running: 0 }
  const runningKins = runningKinsMap.get(ticketId) ?? []
  const reporter = await fetchReporterForTicket(refreshed.reporterUserId, refreshed.reporterKinId)

  const summary = await rowToTicketSummary(refreshed, tags, counts, runningKins, reporter)

  sseManager.broadcast({
    type: 'ticket:updated',
    data: { ticket: summary },
  })

  return summary
}

export async function addTicketTag(ticketId: string, tagId: string): Promise<boolean> {
  const ticket = db.select({ projectId: tickets.projectId }).from(tickets).where(eq(tickets.id, ticketId)).get()
  if (!ticket) return false

  const tag = db.select().from(projectTags).where(eq(projectTags.id, tagId)).get()
  if (!tag || tag.projectId !== ticket.projectId) return false

  db.insert(ticketTags)
    .values({ ticketId, tagId })
    .onConflictDoNothing()
    .run()

  // Trigger a ticket:updated broadcast so kanban refreshes
  const summary = await getTicketSummary(ticketId)
  if (summary) {
    sseManager.broadcast({ type: 'ticket:updated', data: { ticket: summary } })
  }
  return true
}

export async function removeTicketTag(ticketId: string, tagId: string): Promise<boolean> {
  const existing = db
    .select({ ticketId: ticketTags.ticketId })
    .from(ticketTags)
    .where(and(eq(ticketTags.ticketId, ticketId), eq(ticketTags.tagId, tagId)))
    .get()
  if (!existing) return false

  db.delete(ticketTags)
    .where(and(eq(ticketTags.ticketId, ticketId), eq(ticketTags.tagId, tagId)))
    .run()

  const summary = await getTicketSummary(ticketId)
  if (summary) {
    sseManager.broadcast({ type: 'ticket:updated', data: { ticket: summary } })
  }
  return true
}

async function getTicketSummary(ticketId: string): Promise<TicketSummary | null> {
  const row = db.select().from(tickets).where(eq(tickets.id, ticketId)).get()
  if (!row) return null
  const tags = await fetchTagsForTicket(ticketId)
  const [taskCountsMap, runningKinsMap] = await Promise.all([
    fetchTaskCountsForTickets([ticketId]),
    fetchRunningKinsForTickets([ticketId]),
  ])
  const counts = taskCountsMap.get(ticketId) ?? { total: 0, running: 0 }
  const runningKins = runningKinsMap.get(ticketId) ?? []
  const reporter = await fetchReporterForTicket(row.reporterUserId, row.reporterKinId)
  return rowToTicketSummary(row, tags, counts, runningKins, reporter)
}

// ─── Prompt block info ────────────────────────────────────────────────────────

/** Fetch the current ticket + its project context for the sub-Kin prompt.
 *  Returns null if the ticket has been deleted (graceful fallback). */
export async function buildTicketAssignmentInfo(ticketId: string): Promise<TicketAssignmentInfo | null> {
  const ticket = db.select().from(tickets).where(eq(tickets.id, ticketId)).get()
  if (!ticket) return null

  const project = db.select().from(projects).where(eq(projects.id, ticket.projectId)).get()
  if (!project) return null

  const tagLabels = db
    .select({ label: projectTags.label })
    .from(ticketTags)
    .innerJoin(projectTags, eq(ticketTags.tagId, projectTags.id))
    .where(eq(ticketTags.ticketId, ticketId))
    .all()
    .map((r) => r.label)

  return {
    ticketId: ticket.id,
    ticketNumber: ticket.number ?? null,
    ticketTitle: ticket.title,
    ticketDescription: ticket.description,
    ticketStatus: ticket.status,
    ticketTags: tagLabels,
    projectId: project.id,
    projectSlug: project.slug ?? '',
    projectTitle: project.title,
    projectDescription: project.description,
    projectGithubUrl: project.githubUrl,
  }
}

// ─── Start a ticket task ──────────────────────────────────────────────────────

export interface StartTicketTaskResult {
  taskId: string
  ticketId: string
  parentKinId: string
  status: string
  mode: 'await'
  createdAt: number
}

/** Spawn a sub-Kin to work on a ticket. Always in await mode (projects.md § 5).
 *  No side-effect on the ticket — the Kin manages status manually. */
export async function startTicketTask(
  ticketId: string,
  parentKinId: string,
): Promise<StartTicketTaskResult> {
  const ticket = db.select().from(tickets).where(eq(tickets.id, ticketId)).get()
  if (!ticket) throw new Error('TICKET_NOT_FOUND')

  const kin = db.select({ id: kins.id }).from(kins).where(eq(kins.id, parentKinId)).get()
  if (!kin) throw new Error('KIN_NOT_FOUND')

  // Description is intentionally short — the rich ticket context is injected
  // at prompt-build time from tasks.ticket_id (always the current version).
  const description = `Work on ticket: ${ticket.title}`

  const result = await spawnTask({
    parentKinId,
    description,
    title: `Ticket: ${ticket.title}`,
    mode: 'await',
    spawnType: 'self',
    ticketId,
  })

  // Re-read the row to expose status + createdAt without coupling to spawnTask's return shape.
  const row = db.select().from(tasks).where(eq(tasks.id, result.taskId)).get()
  if (!row) throw new Error('TASK_NOT_FOUND_AFTER_SPAWN')

  return {
    taskId: row.id,
    ticketId,
    parentKinId,
    status: row.status,
    mode: 'await',
    createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt),
  }
}

export async function deleteTicket(ticketId: string): Promise<boolean> {
  const existing = db.select({ projectId: tickets.projectId }).from(tickets).where(eq(tickets.id, ticketId)).get()
  if (!existing) return false

  // Cascade: ticket_tags removed by FK. tasks.ticket_id set to NULL by FK (history preserved).
  db.delete(tickets).where(eq(tickets.id, ticketId)).run()

  sseManager.broadcast({
    type: 'ticket:deleted',
    data: { ticketId, projectId: existing.projectId },
  })

  return true
}
