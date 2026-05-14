import { eq, and, count, desc, inArray, sql, ne } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db } from '@/server/db/index'
import { projects, projectTags, tickets, ticketTags, kins } from '@/server/db/schema'
import { sseManager } from '@/server/sse/index'
import { config } from '@/server/config'
import { DEFAULT_PROJECT_TAGS, TICKET_STATUSES } from '@/shared/constants'
import type { Project, ProjectSummary, ProjectTag, TicketStatus } from '@/shared/types'
import type { ActiveProjectPromptInfo } from '@/server/services/prompt-builder'

// ─── Internal helpers ─────────────────────────────────────────────────────────

function rowToProjectTag(row: typeof projectTags.$inferSelect): ProjectTag {
  return { id: row.id, label: row.label, color: row.color }
}

function emptyTicketCounts(): Record<TicketStatus, number> {
  return {
    backlog: 0,
    todo: 0,
    in_progress: 0,
    blocked: 0,
    done: 0,
  }
}

async function fetchTicketCounts(projectId: string): Promise<Record<TicketStatus, number>> {
  const rows = db
    .select({ status: tickets.status, n: count() })
    .from(tickets)
    .where(eq(tickets.projectId, projectId))
    .groupBy(tickets.status)
    .all()
  const counts = emptyTicketCounts()
  for (const row of rows) {
    if ((TICKET_STATUSES as readonly string[]).includes(row.status)) {
      counts[row.status as TicketStatus] = Number(row.n)
    }
  }
  return counts
}

async function fetchProjectTags(projectId: string): Promise<ProjectTag[]> {
  const rows = db
    .select()
    .from(projectTags)
    .where(eq(projectTags.projectId, projectId))
    .all()
  return rows.map(rowToProjectTag)
}

function toMillis(value: Date | number): number {
  return value instanceof Date ? value.getTime() : value
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function listProjects(): Promise<ProjectSummary[]> {
  const rows = db.select().from(projects).all()

  if (rows.length === 0) return []

  // Single aggregate query for ticket counts across all projects
  const countsRows = db
    .select({
      projectId: tickets.projectId,
      status: tickets.status,
      n: count(),
    })
    .from(tickets)
    .groupBy(tickets.projectId, tickets.status)
    .all()

  const totals = new Map<string, { all: number; open: number }>()
  for (const row of countsRows) {
    const entry = totals.get(row.projectId) ?? { all: 0, open: 0 }
    entry.all += Number(row.n)
    if (row.status !== 'done') entry.open += Number(row.n)
    totals.set(row.projectId, entry)
  }

  return rows.map((row): ProjectSummary => {
    const t = totals.get(row.id) ?? { all: 0, open: 0 }
    return {
      id: row.id,
      title: row.title,
      githubUrl: row.githubUrl,
      ticketCount: t.all,
      openTicketCount: t.open,
      createdAt: toMillis(row.createdAt),
      updatedAt: toMillis(row.updatedAt),
    }
  })
}

export async function getProject(projectId: string): Promise<Project | null> {
  const row = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!row) return null

  const [tags, ticketCounts] = await Promise.all([
    fetchProjectTags(projectId),
    fetchTicketCounts(projectId),
  ])

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    githubUrl: row.githubUrl,
    tags,
    ticketCounts,
    createdAt: toMillis(row.createdAt),
    updatedAt: toMillis(row.updatedAt),
  }
}

export interface CreateProjectInput {
  title: string
  description?: string
  githubUrl?: string | null
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const id = uuid()
  const now = new Date()

  db.insert(projects)
    .values({
      id,
      title: input.title,
      description: input.description ?? '',
      githubUrl: input.githubUrl ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run()

  // Seed default tags
  for (const tag of DEFAULT_PROJECT_TAGS) {
    db.insert(projectTags)
      .values({
        id: uuid(),
        projectId: id,
        label: tag.label,
        color: tag.color,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }

  const project = await getProject(id)
  if (!project) throw new Error('Project creation failed: not found after insert')

  sseManager.broadcast({
    type: 'project:created',
    data: {
      project: toProjectSummary(project),
    },
  })

  return project
}

export interface UpdateProjectInput {
  title?: string
  description?: string
  githubUrl?: string | null
}

export async function updateProject(
  projectId: string,
  input: UpdateProjectInput,
): Promise<Project | null> {
  const existing = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!existing) return null

  const now = new Date()
  const update: Partial<typeof projects.$inferInsert> = { updatedAt: now }
  if (input.title !== undefined) update.title = input.title
  if (input.description !== undefined) update.description = input.description
  if (input.githubUrl !== undefined) update.githubUrl = input.githubUrl

  db.update(projects).set(update).where(eq(projects.id, projectId)).run()

  const project = await getProject(projectId)
  if (!project) return null

  sseManager.broadcast({
    type: 'project:updated',
    data: { project: toProjectSummary(project) },
  })

  return project
}

/** Replace, append, or patch the description in a single concern.
 *  Returns the updated project, or null if not found. */
export async function editProjectDescription(
  projectId: string,
  op:
    | { mode: 'replace'; content: string }
    | { mode: 'append'; text: string; separator?: string }
    | { mode: 'patch'; find: string; replace: string },
): Promise<Project | null> {
  const existing = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!existing) return null

  let nextDescription: string
  if (op.mode === 'replace') {
    nextDescription = op.content
  } else if (op.mode === 'append') {
    const separator = op.separator ?? '\n\n'
    nextDescription = existing.description.length > 0
      ? `${existing.description}${separator}${op.text}`
      : op.text
  } else {
    // patch
    if (!existing.description.includes(op.find)) {
      throw new Error(`PATCH_FIND_NOT_FOUND: substring "${op.find}" not found in description`)
    }
    const occurrences = existing.description.split(op.find).length - 1
    if (occurrences > 1) {
      throw new Error(`PATCH_FIND_AMBIGUOUS: substring "${op.find}" matches ${occurrences} times; refine to a unique match`)
    }
    nextDescription = existing.description.replace(op.find, op.replace)
  }

  return updateProject(projectId, { description: nextDescription })
}

export async function deleteProject(projectId: string): Promise<boolean> {
  const existing = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!existing) return false

  // Cascades handled by FK ON DELETE CASCADE for tickets/project_tags/ticket_tags.
  // kins.active_project_id and tasks.ticket_id are reset to NULL by FK ON DELETE SET NULL.
  db.delete(projects).where(eq(projects.id, projectId)).run()

  sseManager.broadcast({
    type: 'project:deleted',
    data: { projectId },
  })

  return true
}

// ─── Active project per Kin ───────────────────────────────────────────────────

export async function setActiveProject(
  kinId: string,
  projectId: string | null,
): Promise<{ activeProjectId: string | null }> {
  // Validate project exists if non-null
  if (projectId !== null) {
    const project = db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get()
    if (!project) throw new Error('PROJECT_NOT_FOUND')
  }

  const existing = db.select({ id: kins.id }).from(kins).where(eq(kins.id, kinId)).get()
  if (!existing) throw new Error('KIN_NOT_FOUND')

  db.update(kins)
    .set({ activeProjectId: projectId, updatedAt: new Date() })
    .where(eq(kins.id, kinId))
    .run()

  sseManager.broadcast({
    type: 'kin:active-project',
    data: { kinId, activeProjectId: projectId },
  })

  return { activeProjectId: projectId }
}

export async function getActiveProjectIdsByKin(): Promise<Map<string, string[]>> {
  const rows = db
    .select({ kinId: kins.id, projectId: kins.activeProjectId })
    .from(kins)
    .where(sql`${kins.activeProjectId} IS NOT NULL`)
    .all()
  const result = new Map<string, string[]>()
  for (const row of rows) {
    if (!row.projectId) continue
    const list = result.get(row.projectId) ?? []
    list.push(row.kinId)
    result.set(row.projectId, list)
  }
  return result
}

// ─── Prompt block info ────────────────────────────────────────────────────────

const TOKEN_CHARS_PER_TOKEN = 4
function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_CHARS_PER_TOKEN)
}

/** Fetch the active project context to inject into the [7.8] prompt block.
 *  Returns null if the project does not exist (graceful fallback for races). */
export async function buildActiveProjectInfo(projectId: string): Promise<ActiveProjectPromptInfo | null> {
  const row = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!row) return null

  // Cap description to maxDescriptionPromptTokens — keep the first half if exceeded.
  const cap = config.projects.maxDescriptionPromptTokens
  const descTokens = estimateTokens(row.description)
  let description = row.description
  let descriptionTruncated = false
  if (descTokens > cap) {
    const charCap = Math.floor((cap / 2) * TOKEN_CHARS_PER_TOKEN)
    description = row.description.slice(0, charCap)
    descriptionTruncated = true
  }

  // Fetch tags and open tickets in parallel
  const tagRows = db.select().from(projectTags).where(eq(projectTags.projectId, projectId)).all()
  const ticketRows = db
    .select()
    .from(tickets)
    .where(and(eq(tickets.projectId, projectId), ne(tickets.status, 'done')))
    .orderBy(desc(tickets.updatedAt))
    .limit(config.projects.maxTicketsInPrompt + 1)
    .all()

  // Total open count (uncapped, for the "and N more" line)
  const totalOpenRow = db
    .select({ n: count() })
    .from(tickets)
    .where(and(eq(tickets.projectId, projectId), ne(tickets.status, 'done')))
    .get()
  const totalOpenTickets = Number(totalOpenRow?.n ?? 0)

  const cappedTickets = ticketRows.slice(0, config.projects.maxTicketsInPrompt)

  // Fetch tags for these tickets in a single query
  const ticketIds = cappedTickets.map((t) => t.id)
  const tagsByTicket = new Map<string, string[]>()
  if (ticketIds.length > 0) {
    const ticketTagRows = db
      .select({ ticketId: ticketTags.ticketId, label: projectTags.label })
      .from(ticketTags)
      .innerJoin(projectTags, eq(ticketTags.tagId, projectTags.id))
      .where(inArray(ticketTags.ticketId, ticketIds))
      .all()
    for (const r of ticketTagRows) {
      const list = tagsByTicket.get(r.ticketId) ?? []
      list.push(r.label)
      tagsByTicket.set(r.ticketId, list)
    }
  }

  return {
    id: row.id,
    title: row.title,
    description,
    descriptionTruncated,
    githubUrl: row.githubUrl,
    tags: tagRows.map((t) => ({ label: t.label, color: t.color })),
    openTickets: cappedTickets.map((t) => ({
      idShort: t.id.slice(0, 8),
      title: t.title,
      status: t.status,
      tagLabels: tagsByTicket.get(t.id) ?? [],
    })),
    totalOpenTickets,
  }
}

/** Convert a full Project into its summary form (used for SSE events). */
function toProjectSummary(p: Project): ProjectSummary {
  const open = (Object.keys(p.ticketCounts) as TicketStatus[])
    .filter((s) => s !== 'done')
    .reduce((acc, s) => acc + (p.ticketCounts[s] ?? 0), 0)
  const total = (Object.keys(p.ticketCounts) as TicketStatus[])
    .reduce((acc, s) => acc + (p.ticketCounts[s] ?? 0), 0)
  return {
    id: p.id,
    title: p.title,
    githubUrl: p.githubUrl,
    ticketCount: total,
    openTicketCount: open,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }
}
