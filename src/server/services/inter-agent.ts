import { eq, and, gte } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import { agents, messages, queueItems, tasks } from '@/server/db/schema'
import { enqueueMessage } from '@/server/services/queue'
import { sseManager } from '@/server/sse/index'
import { config } from '@/server/config'

const log = createLogger('inter-agent')

// ─── Rate limiting (in-memory, per sender→recipient pair) ────────────────────

const rateLimitMap = new Map<string, number[]>()

function checkRateLimit(senderAgentId: string, targetAgentId: string): boolean {
  const key = `${senderAgentId}→${targetAgentId}`
  const now = Date.now()
  const windowMs = 60_000

  let timestamps = rateLimitMap.get(key) ?? []
  // Prune old entries
  timestamps = timestamps.filter((t) => now - t < windowMs)
  rateLimitMap.set(key, timestamps)

  if (timestamps.length >= config.interAgent.rateLimitPerMinute) {
    return false
  }

  timestamps.push(now)
  return true
}

// ─── Chain depth tracking ────────────────────────────────────────────────────

async function getChainDepth(requestId?: string): Promise<number> {
  if (!requestId) return 0

  let depth = 0
  let currentRequestId: string | undefined = requestId

  while (currentRequestId && depth < config.interAgent.maxChainDepth + 1) {
    const msg = await db
      .select({ inReplyTo: messages.inReplyTo })
      .from(messages)
      .where(eq(messages.requestId, currentRequestId))
      .get()

    if (!msg || !msg.inReplyTo) break
    depth++

    // Find the message that this was a reply to
    const parent = await db
      .select({ requestId: messages.requestId })
      .from(messages)
      .where(eq(messages.requestId, msg.inReplyTo))
      .get()

    currentRequestId = parent?.requestId ?? undefined
  }

  return depth
}

// ─── Send message ────────────────────────────────────────────────────────────

interface SendMessageParams {
  senderAgentId: string
  targetAgentId: string
  message: string
  type: 'request' | 'inform'
  chainRequestId?: string // For depth tracking in ongoing chains
  channelOriginId?: string // Causal chain tracking for channel follow-up delivery
}

export async function sendInterAgentMessage(params: SendMessageParams) {
  const { senderAgentId, targetAgentId, message, type, chainRequestId, channelOriginId } = params

  // Validate target Agent exists
  const targetAgent = await db.select().from(agents).where(eq(agents.id, targetAgentId)).get()
  if (!targetAgent) {
    throw new Error('Target Agent not found')
  }

  // Can't message yourself
  if (senderAgentId === targetAgentId) {
    throw new Error('Cannot send a message to yourself')
  }

  // Rate limit check
  if (!checkRateLimit(senderAgentId, targetAgentId)) {
    log.warn({ senderAgentId, targetAgentId }, 'Inter-agent rate limit exceeded')
    throw new Error(
      `Rate limit exceeded: max ${config.interAgent.rateLimitPerMinute} messages/minute to this Agent`,
    )
  }

  // Chain depth check
  const depth = await getChainDepth(chainRequestId)
  if (depth >= config.interAgent.maxChainDepth) {
    throw new Error(`Max chain depth (${config.interAgent.maxChainDepth}) exceeded`)
  }

  const requestId = type === 'request' ? uuid() : undefined
  const senderAgent = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, senderAgentId))
    .get()
  const senderName = senderAgent?.name ?? 'Unknown Agent'

  if (type === 'request') {
    // Request: enqueue in target's FIFO queue → triggers LLM turn
    await enqueueMessage({
      agentId: targetAgentId,
      messageType: 'agent_request',
      content: message,
      sourceType: 'agent',
      sourceId: senderAgentId,
      priority: config.queue.agentPriority,
      requestId,
      channelOriginId,
    })
  } else {
    // Inform: deposit directly in target's session (no queue, no LLM turn)
    const msgId = uuid()
    await db.insert(messages).values({
      id: msgId,
      agentId: targetAgentId,
      role: 'user',
      content: message,
      sourceType: 'agent',
      sourceId: senderAgentId,
      channelOriginId: channelOriginId ?? null,
      createdAt: new Date(),
    })

    // Notify via SSE
    sseManager.sendToAgent(targetAgentId, {
      type: 'chat:message',
      agentId: targetAgentId,
      data: {
        id: msgId,
        role: 'user',
        content: message,
        sourceType: 'agent',
        sourceId: senderAgentId,
        sourceName: senderName,
        createdAt: Date.now(),
      },
    })
  }

  log.info({ senderAgentId, targetAgentId, type, requestId: requestId ?? null }, 'Inter-agent message sent')

  return { requestId: requestId ?? null }
}

// ─── Reply ───────────────────────────────────────────────────────────────────

interface ReplyParams {
  senderAgentId: string
  requestId: string
  message: string
}

export async function replyToInterAgentMessage(params: ReplyParams) {
  const { senderAgentId, requestId, message } = params

  // Check if a sub-Agent task is suspended waiting for this reply
  const suspendedTask = await db
    .select()
    .from(tasks)
    .where(and(
      eq(tasks.pendingRequestId, requestId),
      eq(tasks.status, 'awaiting_agent_response'),
    ))
    .get()

  if (suspendedTask) {
    // Route reply directly to the suspended task instead of the main session
    const senderAgent = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, senderAgentId))
      .get()
    const senderName = senderAgent?.name ?? 'Unknown Agent'

    const { resumeTaskFromAgentResponse } = await import('@/server/services/tasks')
    await resumeTaskFromAgentResponse(suspendedTask.id, senderAgentId, senderName, message)

    log.info({ taskId: suspendedTask.id, requestId, senderAgentId }, 'Inter-Agent reply routed to suspended task')
    return { success: true }
  }

  // Find the original request to determine sender
  const originalQueueItem = await db
    .select()
    .from(queueItems)
    .where(eq(queueItems.requestId, requestId))
    .get()

  // Also search in messages table (might have been processed already)
  const originalMessage = await db
    .select()
    .from(messages)
    .where(eq(messages.requestId, requestId))
    .get()

  const originalSenderId = originalQueueItem?.sourceId ?? originalMessage?.sourceId
  if (!originalSenderId) {
    throw new Error('Original request not found — cannot correlate reply')
  }

  // Propagate channel origin from the original request through the reply chain
  const channelOriginId = originalQueueItem?.channelOriginId ?? originalMessage?.channelOriginId

  const senderAgent = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, senderAgentId))
    .get()
  const senderName = senderAgent?.name ?? 'Unknown Agent'

  // Reply enqueued → triggers LLM turn so the agent can acknowledge the reply.
  // Inter-agent tools are REMOVED during agent_reply processing (see agent-engine.ts)
  // to prevent ping-pong loops.
  await enqueueMessage({
    agentId: originalSenderId,
    messageType: 'agent_reply',
    content: message,
    sourceType: 'agent',
    sourceId: senderAgentId,
    priority: config.queue.agentPriority,
    inReplyTo: requestId,
    channelOriginId: channelOriginId ?? undefined,
  })

  return { success: true }
}

// ─── List available Agents ─────────────────────────────────────────────────────

export async function listAvailableAgents(excludeAgentId?: string) {
  const allAgents = await db
    .select({
      id: agents.id,
      slug: agents.slug,
      name: agents.name,
      role: agents.role,
    })
    .from(agents)
    .all()

  // Exclude self from the list
  if (excludeAgentId) {
    return allAgents.filter((k) => k.id !== excludeAgentId)
  }

  return allAgents
}
