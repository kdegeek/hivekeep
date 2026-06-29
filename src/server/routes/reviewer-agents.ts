import { Hono, type Context, type Next } from 'hono'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { AppVariables } from '@/server/app'
import { db } from '@/server/db/index'
import { userProfiles } from '@/server/db/schema'
import { getReviewRun, listReviewRuns, type ReviewFindingState } from '@/server/services/local-review'
import {
  getReviewerAgent,
  listReviewerAgents,
  listReviewerChecklists,
  runReviewerAgentReview,
  setReviewerFindingState,
  updateReviewerChecklist,
  type ReviewerAgentId,
} from '@/server/services/reviewer-agents'

export const reviewerAgentRoutes = new Hono<{ Variables: AppVariables }>()

const reviewerAgentIdSchema = z.enum(['coderabbit-reviewer', 'kilo-code-reviewer'])
const modeSchema = z.enum(['advisory', 'blocking']).optional()
const findingStateSchema = z.enum(['open', 'fixed', 'ignored', 'needs-decision'])

function error(c: Context<{ Variables: AppVariables }>, code: string, message: string, status: 400 | 404) {
  return c.json({ error: { code, message } }, status)
}

async function requireAdmin(c: Context<{ Variables: AppVariables }>, next: Next) {
  const user = c.get('user')
  const profile = await db
    .select({ role: userProfiles.role })
    .from(userProfiles)
    .where(eq(userProfiles.userId, user.id))
    .get()
  if (!profile || profile.role !== 'admin') {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Admin access required' } }, 403)
  }
  return next()
}

reviewerAgentRoutes.use('*', requireAdmin)

reviewerAgentRoutes.get('/', async (c) => {
  const repoPath = c.req.query('repoPath') ?? process.cwd()
  return c.json({ agents: await listReviewerAgents(repoPath) })
})

reviewerAgentRoutes.get('/checklists', async (c) => {
  const parsed = reviewerAgentIdSchema.optional().safeParse(c.req.query('reviewerAgentId'))
  if (!parsed.success) return error(c, 'INVALID_REVIEWER_AGENT', 'Unknown reviewer agent id.', 400)
  return c.json({ checklists: listReviewerChecklists(parsed.data) })
})

reviewerAgentRoutes.patch('/checklists/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const parsed = z.object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    memoryTags: z.array(z.string()).optional(),
    instructionTags: z.array(z.string()).optional(),
    items: z.array(z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      description: z.string().optional(),
      required: z.boolean(),
      defaultState: z.enum(['unchecked', 'checked', 'needs-decision']),
    })).optional(),
  }).safeParse(body)
  if (!parsed.success) return error(c, 'INVALID_CHECKLIST_PATCH', parsed.error.issues[0]?.message ?? 'Invalid checklist patch.', 400)
  try {
    return c.json({ checklist: updateReviewerChecklist(c.req.param('id'), parsed.data) })
  } catch (err) {
    return error(c, 'CHECKLIST_NOT_FOUND', err instanceof Error ? err.message : 'Checklist not found.', 404)
  }
})

reviewerAgentRoutes.get('/runs', (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20), 1), 100)
  return c.json({ runs: listReviewRuns(limit) })
})

reviewerAgentRoutes.get('/runs/:id', (c) => {
  const run = getReviewRun(c.req.param('id'))
  if (!run) return error(c, 'RUN_NOT_FOUND', 'Review run not found.', 404)
  return c.json({ run })
})

reviewerAgentRoutes.patch('/runs/:id/findings/:findingId', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const parsed = z.object({ state: findingStateSchema, note: z.string().optional() }).safeParse(body)
  if (!parsed.success) return error(c, 'INVALID_FINDING_STATE', 'Invalid finding state.', 400)
  try {
    const run = setReviewerFindingState(c.req.param('id'), c.req.param('findingId'), parsed.data.state as ReviewFindingState, parsed.data.note)
    return c.json({ run })
  } catch (err) {
    return error(c, 'FINDING_NOT_FOUND', err instanceof Error ? err.message : 'Finding not found.', 404)
  }
})

reviewerAgentRoutes.get('/:id', async (c) => {
  const parsed = reviewerAgentIdSchema.safeParse(c.req.param('id'))
  if (!parsed.success) return error(c, 'INVALID_REVIEWER_AGENT', 'Unknown reviewer agent id.', 404)
  const agent = await getReviewerAgent(parsed.data, c.req.query('repoPath') ?? process.cwd())
  if (!agent) return error(c, 'REVIEWER_AGENT_NOT_FOUND', 'Reviewer agent not found.', 404)
  return c.json({ agent })
})

reviewerAgentRoutes.post('/:id/runs', async (c) => {
  const id = reviewerAgentIdSchema.safeParse(c.req.param('id'))
  if (!id.success) return error(c, 'INVALID_REVIEWER_AGENT', 'Unknown reviewer agent id.', 404)
  const body = await c.req.json().catch(() => ({}))
  const parsed = z.object({
    repoPath: z.string().min(1),
    base: z.string().optional(),
    baseCommit: z.string().optional(),
    head: z.string().optional(),
    mode: modeSchema,
    light: z.boolean().optional(),
    timeoutMs: z.number().int().min(1000).optional(),
  }).safeParse(body)
  if (!parsed.success) return error(c, 'INVALID_REVIEW_INPUT', parsed.error.issues[0]?.message ?? 'Invalid review input.', 400)
  const run = await runReviewerAgentReview({ reviewerAgentId: id.data as ReviewerAgentId, ...parsed.data })
  return c.json({ run })
})
