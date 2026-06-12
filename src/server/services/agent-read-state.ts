import { db, sqlite } from '@/server/db/index'
import { agentReadState } from '@/server/db/schema'
import { sseManager } from '@/server/sse/index'

/**
 * Bump the read marker for (userId, agentId) to "now". Used when the user opens
 * an Agent or when a fresh assistant message arrives in the currently viewed Agent.
 */
export async function markAgentAsRead(userId: string, agentId: string): Promise<void> {
  const now = new Date()
  await db
    .insert(agentReadState)
    .values({ userId, agentId, lastReadAt: now })
    .onConflictDoUpdate({
      target: [agentReadState.userId, agentReadState.agentId],
      set: { lastReadAt: now },
    })

  sseManager.sendToUser(userId, {
    type: 'agent:read',
    data: { agentId, lastReadAt: now.getTime() },
  })
}

/**
 * Return per-Agent unread counts for the given user.
 *
 * Mirrors the client-side filter in useUnreadPerAgent: only assistant messages
 * that are not part of a task or quick-session, and not redacted.
 *
 * If an Agent has no read_state row, the floor is `MAX(user.created_at, agent.created_at)`,
 * so messages predating either are not counted (avoids flooding new users).
 *
 * Only Agents with at least 1 unread message appear in the result.
 */
export function getUnreadCountsForUser(userId: string): Record<string, number> {
  const rows = sqlite
    .query<{ agent_id: string; unread: number }, [string]>(
      `SELECT
         k.id AS agent_id,
         COUNT(m.id) AS unread
       FROM agents k
       CROSS JOIN user u
       LEFT JOIN agent_read_state krs
         ON krs.user_id = u.id AND krs.agent_id = k.id
       LEFT JOIN messages m
         ON m.agent_id = k.id
         AND m.role = 'assistant'
         AND m.task_id IS NULL
         AND m.session_id IS NULL
         AND m.is_redacted = 0
         AND m.created_at > COALESCE(
           krs.last_read_at,
           MAX(u.created_at, k.created_at)
         )
       WHERE u.id = ?
       GROUP BY k.id
       HAVING COUNT(m.id) > 0`,
    )
    .all(userId)

  const result: Record<string, number> = {}
  for (const row of rows) {
    result[row.agent_id] = Number(row.unread)
  }
  return result
}
