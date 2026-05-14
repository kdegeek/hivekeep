import { eq, and } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db } from '@/server/db/index'
import { projectTags, projects } from '@/server/db/schema'
import { sseManager } from '@/server/sse/index'
import type { ProjectTag } from '@/shared/types'

function rowToTag(row: typeof projectTags.$inferSelect): ProjectTag {
  return { id: row.id, label: row.label, color: row.color }
}

export async function listProjectTags(projectId: string): Promise<ProjectTag[]> {
  const rows = db.select().from(projectTags).where(eq(projectTags.projectId, projectId)).all()
  return rows.map(rowToTag)
}

export interface CreateTagInput {
  projectId: string
  label: string
  color: string
}

export async function createTag(input: CreateTagInput): Promise<ProjectTag> {
  // Validate project exists
  const project = db.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).get()
  if (!project) throw new Error('PROJECT_NOT_FOUND')

  // Check uniqueness (project_id, label)
  const existing = db
    .select({ id: projectTags.id })
    .from(projectTags)
    .where(and(eq(projectTags.projectId, input.projectId), eq(projectTags.label, input.label)))
    .get()
  if (existing) throw new Error('TAG_LABEL_TAKEN')

  const id = uuid()
  const now = new Date()
  db.insert(projectTags)
    .values({
      id,
      projectId: input.projectId,
      label: input.label,
      color: input.color,
      createdAt: now,
      updatedAt: now,
    })
    .run()

  const tag: ProjectTag = { id, label: input.label, color: input.color }
  sseManager.broadcast({
    type: 'project-tag:created',
    data: { tag, projectId: input.projectId },
  })

  return tag
}

export interface UpdateTagInput {
  label?: string
  color?: string
}

export async function updateTag(tagId: string, input: UpdateTagInput): Promise<ProjectTag | null> {
  const existing = db.select().from(projectTags).where(eq(projectTags.id, tagId)).get()
  if (!existing) return null

  // Check uniqueness if label is being changed
  if (input.label !== undefined && input.label !== existing.label) {
    const dupe = db
      .select({ id: projectTags.id })
      .from(projectTags)
      .where(and(eq(projectTags.projectId, existing.projectId), eq(projectTags.label, input.label)))
      .get()
    if (dupe) throw new Error('TAG_LABEL_TAKEN')
  }

  const now = new Date()
  const update: Partial<typeof projectTags.$inferInsert> = { updatedAt: now }
  if (input.label !== undefined) update.label = input.label
  if (input.color !== undefined) update.color = input.color

  db.update(projectTags).set(update).where(eq(projectTags.id, tagId)).run()

  const row = db.select().from(projectTags).where(eq(projectTags.id, tagId)).get()
  if (!row) return null
  const tag = rowToTag(row)

  sseManager.broadcast({
    type: 'project-tag:updated',
    data: { tag, projectId: row.projectId },
  })

  return tag
}

export async function deleteTag(tagId: string): Promise<boolean> {
  const existing = db.select().from(projectTags).where(eq(projectTags.id, tagId)).get()
  if (!existing) return false

  // Cascade: ticket_tags rows are removed by FK ON DELETE CASCADE
  db.delete(projectTags).where(eq(projectTags.id, tagId)).run()

  sseManager.broadcast({
    type: 'project-tag:deleted',
    data: { tagId, projectId: existing.projectId },
  })

  return true
}
