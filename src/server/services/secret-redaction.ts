/**
 * Retroactive secret-leak redaction (the `redact_secret_leak` tool backend).
 *
 * Thin binder around `scrubLeakedValue` (secret-substitution.ts): resolves
 * the vault value, applies the safety floor, and wires the engine to drizzle
 * and the SSE manager. Scans ALL conversations (main, tasks, quick sessions,
 * every agent) — a leaked value is leaked everywhere it appears — across
 * message `content`, the `tool_calls` JSON (where most leaks actually live:
 * tool results echoing the value, replayed verbatim to the LLM by
 * buildMessageHistory), and compacting summaries.
 *
 * Surgical: the rest of each message survives, so `isRedacted` is NOT set
 * (that flag hides the whole message and is reserved for full replacement).
 * Emits `chat:messages-redacted` per affected agent so connected clients
 * refetch instead of keeping the secret on screen.
 */
import { and, eq, or, sql } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { messages, compactingSummaries } from '@/server/db/schema'
import { getSecretValue } from '@/server/services/vault'
import {
  scrubLeakedValue,
  sweepRevealedCarriers,
  MIN_REDACTABLE_SECRET_LENGTH,
  type LeakScrubStore,
} from '@/server/services/secret-substitution'
import { sseManager } from '@/server/sse/index'
import { createLogger } from '@/server/logger'

const log = createLogger('secret-redaction')

export interface RedactLeakResult {
  ok: boolean
  error?: string
  messagesCleaned: number
  summariesCleaned: number
}

const drizzleStore: LeakScrubStore = {
  async findCandidateMessages(contentPattern, toolCallsPattern) {
    return db
      .select({ id: messages.id, agentId: messages.agentId, content: messages.content, toolCalls: messages.toolCalls })
      .from(messages)
      .where(
        or(
          sql`${messages.content} LIKE ${contentPattern} ESCAPE '\\'`,
          sql`${messages.toolCalls} LIKE ${toolCallsPattern} ESCAPE '\\'`,
        ),
      )
      .all()
  },
  async updateMessage(id, updates) {
    await db.update(messages).set(updates).where(eq(messages.id, id))
  },
  async findCandidateSummaries(contentPattern) {
    return db
      .select({ id: compactingSummaries.id, summary: compactingSummaries.summary })
      .from(compactingSummaries)
      .where(sql`${compactingSummaries.summary} LIKE ${contentPattern} ESCAPE '\\'`)
      .all()
  },
  async updateSummary(id, summary) {
    await db.update(compactingSummaries).set({ summary }).where(eq(compactingSummaries.id, id))
  },
  emitRedacted(agentId, messageIds) {
    sseManager.sendToAgent(agentId, {
      type: 'chat:messages-redacted',
      agentId,
      data: { agentId, messageIds },
    })
  },
}

export async function redactSecretLeak(key: string): Promise<RedactLeakResult> {
  const value = await getSecretValue(key)
  if (value === null) {
    return { ok: false, error: `Secret with key "${key}" not found`, messagesCleaned: 0, summariesCleaned: 0 }
  }
  if (value.length < MIN_REDACTABLE_SECRET_LENGTH) {
    return {
      ok: false,
      error: `Secret value is too short (< ${MIN_REDACTABLE_SECRET_LENGTH} chars) to scrub safely — scanning for it would mangle legitimate text.`,
      messagesCleaned: 0,
      summariesCleaned: 0,
    }
  }

  const { messagesCleaned, summariesCleaned } = await scrubLeakedValue(key, value, drizzleStore)
  log.info({ secretKey: key, messagesCleaned, summariesCleaned }, 'Secret leak scrubbed from history')
  return { ok: true, messagesCleaned, summariesCleaned }
}

/**
 * End-of-turn / boot sweep for reveal_secret carrier messages — see
 * `sweepRevealedCarriers` (secret-substitution.ts) for the engine. Called
 * (awaited) at the end of every main-conversation turn BEFORE the compacting
 * trigger, and once at boot (crash recovery: a turn that died mid-flight
 * must not leave the raw value in the history).
 */
export async function sweepRevealedSecrets(agentId?: string): Promise<number> {
  const count = await sweepRevealedCarriers(
    {
      async findPendingCarriers(aid) {
        return db
          .select({ id: messages.id, agentId: messages.agentId, metadata: messages.metadata })
          .from(messages)
          .where(
            aid
              ? and(eq(messages.redactPending, true), eq(messages.agentId, aid))
              : eq(messages.redactPending, true),
          )
          .all()
      },
      async redactCarrier(id, content) {
        await db
          .update(messages)
          .set({ content, isRedacted: true, redactPending: false })
          .where(eq(messages.id, id))
      },
      async scrubKey(key) {
        const res = await redactSecretLeak(key)
        if (!res.ok) log.warn({ key, error: res.error }, 'Post-reveal scrub skipped')
      },
      emitRedacted(aid, messageIds) {
        sseManager.sendToAgent(aid, {
          type: 'chat:messages-redacted',
          agentId: aid,
          data: { agentId: aid, messageIds },
        })
      },
    },
    agentId,
  )
  if (count > 0) log.info({ count }, 'Revealed-secret carriers redacted')
  return count
}
