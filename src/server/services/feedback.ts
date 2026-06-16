import { eq, sql } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { feedbackState, user, messages } from '@/server/db/schema'
import { getSetting, setSetting } from '@/server/services/app-settings'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'

const log = createLogger('feedback')

export const FEEDBACK_TYPES = ['bug', 'suggestion', 'experience'] as const
export type FeedbackType = (typeof FEEDBACK_TYPES)[number]

const INSTANCE_ID_KEY = 'anonymous_instance_id'

/** Whether the in-app feedback feature is configured (endpoint set). */
export function isFeedbackEnabled(): boolean {
  return !!config.feedback.endpoint
}

/**
 * Stable, anonymous identifier for this install. Used only to group feedback by
 * instance on the collector side (no user/PII). Generated once and persisted.
 */
export async function getOrCreateInstanceId(): Promise<string> {
  const existing = await getSetting(INSTANCE_ID_KEY)
  if (existing) return existing
  const id = crypto.randomUUID()
  await setSetting(INSTANCE_ID_KEY, id)
  return id
}

interface FeedbackStateRow {
  dismissed: boolean
  snoozedUntil: number | null
  starredAt: number | null
  submitCount: number
}

function readState(userId: string): FeedbackStateRow {
  const row = db
    .select({
      dismissed: feedbackState.dismissed,
      snoozedUntil: feedbackState.snoozedUntil,
      starredAt: feedbackState.starredAt,
      submitCount: feedbackState.submitCount,
    })
    .from(feedbackState)
    .where(eq(feedbackState.userId, userId))
    .get()
  return row ?? { dismissed: false, snoozedUntil: null, starredAt: null, submitCount: 0 }
}

/** Total human-authored messages across the instance — a proxy for "real usage". */
function totalUserMessages(): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(messages)
    .where(eq(messages.sourceType, 'user'))
    .get()
  return row?.n ?? 0
}

function accountAgeDays(userId: string): number {
  const row = db.select({ createdAt: user.createdAt }).from(user).where(eq(user.id, userId)).get()
  if (!row?.createdAt) return 0
  const createdMs = row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt)
  return (Date.now() - createdMs) / (1000 * 60 * 60 * 24)
}

export interface FeedbackStateView {
  enabled: boolean
  /** True when the proactive banner should be shown to this user right now. */
  shouldPrompt: boolean
  /** User already clicked the GitHub star CTA. */
  starred: boolean
  githubUrl: string
}

export function getFeedbackStateView(userId: string): FeedbackStateView {
  const enabled = isFeedbackEnabled()
  const state = readState(userId)
  const now = Date.now()

  const eligible =
    accountAgeDays(userId) >= config.feedback.promptAfterDays ||
    totalUserMessages() >= config.feedback.promptMinMessages

  const snoozed = state.snoozedUntil != null && state.snoozedUntil > now
  const shouldPrompt = enabled && eligible && !state.dismissed && !snoozed

  return {
    enabled,
    shouldPrompt,
    starred: state.starredAt != null,
    githubUrl: config.feedback.githubRepoUrl,
  }
}

function upsertState(userId: string, set: Record<string, unknown>): void {
  const now = new Date()
  db.insert(feedbackState)
    .values({ userId, updatedAt: now, ...set })
    .onConflictDoUpdate({ target: feedbackState.userId, set: { ...set, updatedAt: now } })
    .run()
}

export type FeedbackAction = 'snooze' | 'dismiss' | 'starred' | 'shown'

export function applyFeedbackAction(userId: string, action: FeedbackAction): void {
  switch (action) {
    case 'snooze':
      upsertState(userId, {
        snoozedUntil: Date.now() + config.feedback.snoozeDays * 24 * 60 * 60 * 1000,
      })
      break
    case 'dismiss':
      upsertState(userId, { dismissed: true })
      break
    case 'starred':
      upsertState(userId, { starredAt: Date.now() })
      break
    case 'shown':
      upsertState(userId, { lastPromptAt: Date.now() })
      break
  }
}

export interface SubmitFeedbackInput {
  type: FeedbackType
  message: string
  email?: string | null
  locale?: string | null
}

/**
 * Relay one feedback item to the central collector and bump the user's submit
 * count. The instance version + anonymous instance id are attached server-side
 * (never trusted from the client).
 */
export async function submitFeedback(userId: string, input: SubmitFeedbackInput): Promise<void> {
  if (!isFeedbackEnabled()) {
    throw new Error('feedback_disabled')
  }

  const instanceId = await getOrCreateInstanceId()
  const payload = {
    type: input.type,
    message: input.message,
    email: input.email || null,
    version: config.version,
    instanceId,
    locale: input.locale || null,
  }

  const res = await fetch(config.feedback.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    log.warn({ status: res.status, body }, 'Feedback relay failed')
    throw new Error(`relay_failed_${res.status}`)
  }

  const now = new Date()
  db.insert(feedbackState)
    .values({ userId, submitCount: 1, updatedAt: now })
    .onConflictDoUpdate({
      target: feedbackState.userId,
      set: { submitCount: sql`${feedbackState.submitCount} + 1`, updatedAt: now },
    })
    .run()
  log.info({ userId, type: input.type }, 'Feedback submitted')
}
