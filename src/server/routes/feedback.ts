import { Hono } from 'hono'
import type { AppVariables } from '@/server/app'
import { createLogger } from '@/server/logger'
import { config } from '@/server/config'
import {
  FEEDBACK_TYPES,
  type FeedbackType,
  type FeedbackAction,
  getFeedbackStateView,
  applyFeedbackAction,
  submitFeedback,
} from '@/server/services/feedback'

const log = createLogger('routes:feedback')
const feedbackRoutes = new Hono<{ Variables: AppVariables }>()

const VALID_ACTIONS: readonly FeedbackAction[] = ['snooze', 'dismiss', 'starred', 'shown']

// GET /api/feedback/state — banner eligibility + star state for the current user
feedbackRoutes.get('/state', (c) => {
  const sessionUser = c.get('user') as { id: string }
  return c.json(getFeedbackStateView(sessionUser.id))
})

// PATCH /api/feedback/state — record a banner action (snooze / dismiss / starred / shown)
feedbackRoutes.patch('/state', async (c) => {
  const sessionUser = c.get('user') as { id: string }
  const body = await c.req.json().catch(() => ({}))
  const action = body?.action as FeedbackAction

  if (!VALID_ACTIONS.includes(action)) {
    return c.json(
      { error: { code: 'INVALID_ACTION', message: `action must be one of: ${VALID_ACTIONS.join(', ')}` } },
      400,
    )
  }

  applyFeedbackAction(sessionUser.id, action)
  return c.json(getFeedbackStateView(sessionUser.id))
})

// POST /api/feedback — submit written feedback (relayed to the central collector)
feedbackRoutes.post('/', async (c) => {
  const sessionUser = c.get('user') as { id: string }
  const body = await c.req.json().catch(() => ({}))

  const type = body?.type as FeedbackType
  const message = typeof body?.message === 'string' ? body.message.trim() : ''
  const email = typeof body?.email === 'string' ? body.email.trim() : null
  const locale = typeof body?.locale === 'string' ? body.locale.slice(0, 20) : null

  if (!FEEDBACK_TYPES.includes(type)) {
    return c.json(
      { error: { code: 'INVALID_TYPE', message: `type must be one of: ${FEEDBACK_TYPES.join(', ')}` } },
      400,
    )
  }
  if (!message) {
    return c.json({ error: { code: 'EMPTY_MESSAGE', message: 'Feedback message is required' } }, 400)
  }
  if (message.length > config.feedback.maxMessageLength) {
    return c.json(
      { error: { code: 'MESSAGE_TOO_LONG', message: `Feedback must be under ${config.feedback.maxMessageLength} characters` } },
      400,
    )
  }
  if (email && email.length > 200) {
    return c.json({ error: { code: 'EMAIL_TOO_LONG', message: 'Email is too long' } }, 400)
  }

  try {
    await submitFeedback(sessionUser.id, { type, message, email, locale })
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown'
    if (reason === 'feedback_disabled') {
      return c.json({ error: { code: 'FEEDBACK_DISABLED', message: 'Feedback is not enabled on this instance' } }, 503)
    }
    log.warn({ reason }, 'Feedback submission failed')
    return c.json(
      { error: { code: 'FEEDBACK_RELAY_FAILED', message: 'Could not deliver feedback, please try again later' } },
      502,
    )
  }

  return c.json({ ok: true }, 201)
})

export { feedbackRoutes }
