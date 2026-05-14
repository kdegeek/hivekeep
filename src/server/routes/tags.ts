import { Hono } from 'hono'
import { updateTag, deleteTag } from '@/server/services/project-tags'
import type { AppVariables } from '@/server/app'

export const tagRoutes = new Hono<{ Variables: AppVariables }>()

tagRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const update: { label?: string; color?: string } = {}
  if (typeof body.label === 'string') update.label = body.label
  if (typeof body.color === 'string') update.color = body.color
  try {
    const tag = await updateTag(id, update)
    if (!tag) {
      return c.json({ error: { code: 'TAG_NOT_FOUND', message: 'Tag not found' } }, 404)
    }
    return c.json({ tag })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg === 'TAG_LABEL_TAKEN') {
      return c.json({ error: { code: 'TAG_LABEL_TAKEN', message: 'A tag with this label already exists in this project' } }, 409)
    }
    return c.json({ error: { code: 'INTERNAL', message: msg } }, 500)
  }
})

tagRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const ok = await deleteTag(id)
  if (!ok) {
    return c.json({ error: { code: 'TAG_NOT_FOUND', message: 'Tag not found' } }, 404)
  }
  return c.json({ success: true })
})
