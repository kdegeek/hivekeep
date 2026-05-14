import { eq, and, inArray, max, count, desc } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db } from '@/server/db/index'
import { tickets, ticketTags, projectTags, projects, tasks, kins } from '@/server/db/schema'
import { sseManager } from '@/server/sse/index'
import { config } from '@/server/config'
import { TICKET_STATUSES } from '@/shared/constants'
import { spawnTask } from '@/server/services/tasks'
import type {
  Ticket,
  TicketStatus,
  TicketSummary,
  TicketTaskSummary,
  ProjectTag,
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

async function rowToTicketSummary(
  row: typeof tickets.$inferSelect,
  tags: ProjectTag[],
  taskCounts: { total: number; running: number },
): Promise<TicketSummary> {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    status: row.status as TicketStatus,
    position: row.position,
    tags,
    taskCount: taskCounts.total,
    runningTaskCount: taskCounts.running,
    createdAt: toMillis(row.createdAt),
    updatedAt: toMillis(row.updatedAt),
  }
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
  const [tagsByTicket, taskCountsByTicket] = await Promise.all([
    fetchTagsForTickets(ids),
    fetchTaskCountsForTickets(ids),
  ])

  const items = await Promise.all(
    slice.map((row) =>
      rowToTicketSummary(
        row,
        tagsByTicket.get(row.id) ?? [],
        taskCountsByTicket.get(row.id) ?? { total: 0, running: 0 },
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

  const taskCountsMap = await fetchTaskCountsForTickets([ticketId])
  const counts = taskCountsMap.get(ticketId) ?? { total: 0, running: 0 }

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
    title: row.title,
    description: row.description,
    status: row.status as TicketStatus,
    position: row.position,
    tags,
    taskCount: counts.total,
    runningTaskCount: counts.running,
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
}

export async function createTicket(input: CreateTicketInput): Promise<TicketSummary> {
  const project = db.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).get()
  if (!project) throw new Error('PROJECT_NOT_FOUND')

  const status = input.status ?? 'backlog'
  if (!isValidStatus(status)) throw new Error('INVALID_STATUS')

  const id = uuid()
  const now = new Date()
  const position = await computeNextPositionInColumn(input.projectId, status)

  db.insert(tickets)
    .values({
      id,
      projectId: input.projectId,
      title: input.title,
      description: input.description ?? '',
      status,
      position,
      createdAt: now,
      updatedAt: now,
    })
    .run()

  if (input.tagIds && input.tagIds.length > 0) {
    await setTicketTags(id, input.tagIds)
  }

  const tags = await fetchTagsForTicket(id)
  const summary: TicketSummary = {
    id,
    projectId: input.projectId,
    title: input.title,
    description: input.description ?? '',
    status,
    position,
    tags,
    taskCount: 0,
    runningTaskCount: 0,
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
  const taskCountsMap = await fetchTaskCountsForTickets([ticketId])
  const counts = taskCountsMap.get(ticketId) ?? { total: 0, running: 0 }

  const summary = await rowToTicketSummary(refreshed, tags, counts)

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
  const taskCountsMap = await fetchTaskCountsForTickets([ticketId])
  const counts = taskCountsMap.get(ticketId) ?? { total: 0, running: 0 }
  return rowToTicketSummary(row, tags, counts)
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
    ticketTitle: ticket.title,
    ticketDescription: ticket.description,
    ticketStatus: ticket.status,
    ticketTags: tagLabels,
    projectId: project.id,
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
