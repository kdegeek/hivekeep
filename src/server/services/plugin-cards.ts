import { v4 as uuid } from 'uuid'
import { and, eq, like } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { messages } from '@/server/db/schema'
import { sseManager } from '@/server/sse/index'
import { createLogger } from '@/server/logger'
import type {
  PluginCard,
  PluginCardPrimitive,
} from '@/shared/types/plugin-cards'

const log = createLogger('plugin-cards')

// ─── Internals ───────────────────────────────────────────────────────────────
//
// Cards live as system messages, exactly like the channel-transfer audit
// rows (see src/server/services/channels.ts). The full PluginCard is JSON
// serialized into `messages.metadata` under the keys:
//   { systemEvent: 'plugin-card', pluginCard: { ... } }
// so /api/messages can surface a typed systemEvent blob to the client and
// MessageBubble can route to the dedicated renderer.
//
// State updates rewrite the persisted pluginCard.state and broadcast
// `card:updated` so existing UIs merge the patch in place without refetch.

interface PersistedMetadata {
  systemEvent: 'plugin-card'
  pluginCard: PluginCard
  /** Mirrored at top-level for symmetry with other audit rows; ignored on read. */
  pluginId?: string
}

function parseMetadata(raw: string | null): PersistedMetadata | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedMetadata>
    if (parsed?.systemEvent !== 'plugin-card' || !parsed.pluginCard) return null
    return parsed as PersistedMetadata
  } catch {
    return null
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface EmitPluginCardParams {
  agentId: string
  pluginId: string
  cardType: string
  layout: PluginCardPrimitive[]
  initialState: Record<string, unknown>
}

export interface EmitPluginCardResult {
  messageId: string
  cardInstanceId: string
}

/**
 * Persist a new plugin card as a system message and broadcast it as a
 * `chat:message` SSE so clients render it immediately without refetching.
 */
export async function emitPluginCard(params: EmitPluginCardParams): Promise<EmitPluginCardResult> {
  const cardInstanceId = uuid()
  const card: PluginCard = {
    pluginId: params.pluginId,
    cardType: params.cardType,
    cardInstanceId,
    layout: params.layout,
    state: { ...params.initialState },
  }

  const metadata: PersistedMetadata = {
    systemEvent: 'plugin-card',
    pluginCard: card,
    pluginId: params.pluginId,
  }

  const messageId = uuid()
  const now = new Date()
  await db.insert(messages).values({
    id: messageId,
    agentId: params.agentId,
    role: 'system',
    content: null,
    sourceType: 'system',
    sourceId: null,
    metadata: JSON.stringify(metadata),
    createdAt: now,
  })

  // Mirror the /api/messages enrichment shape so the client can pick this up
  // through its existing `chat:message` handler without any extra plumbing.
  sseManager.sendToAgent(params.agentId, {
    type: 'chat:message',
    agentId: params.agentId,
    data: {
      id: messageId,
      role: 'system',
      content: null,
      sourceType: 'system',
      sourceId: null,
      sourceName: null,
      systemEvent: { type: 'plugin-card', pluginCard: card },
      createdAt: now.getTime(),
    },
  })

  log.debug(
    { agentId: params.agentId, pluginId: params.pluginId, cardInstanceId, cardType: params.cardType },
    'plugin card emitted',
  )

  return { messageId, cardInstanceId }
}

export interface UpdatePluginCardParams {
  cardInstanceId: string
  /** Partial state patch. Merged shallowly into the persisted state. */
  state: Record<string, unknown>
}

/**
 * Patch the state of a previously emitted card. Rewrites the persisted
 * metadata and broadcasts `card:updated` so live renderers merge in place.
 * No-op (with a debug log) if the card cannot be located.
 */
export async function updatePluginCard(params: UpdatePluginCardParams): Promise<void> {
  const row = await findMessageByCardInstanceId(params.cardInstanceId)
  if (!row) {
    log.debug({ cardInstanceId: params.cardInstanceId }, 'updatePluginCard: card not found, dropping patch')
    return
  }
  const meta = parseMetadata(row.metadata)
  if (!meta) {
    log.warn({ cardInstanceId: params.cardInstanceId, messageId: row.id }, 'updatePluginCard: metadata is not a plugin card, ignoring')
    return
  }

  const nextState = { ...meta.pluginCard.state, ...params.state }
  const nextMeta: PersistedMetadata = {
    ...meta,
    pluginCard: { ...meta.pluginCard, state: nextState },
  }

  await db
    .update(messages)
    .set({ metadata: JSON.stringify(nextMeta) })
    .where(eq(messages.id, row.id))

  sseManager.sendToAgent(row.agentId, {
    type: 'card:updated',
    agentId: row.agentId,
    data: {
      cardInstanceId: params.cardInstanceId,
      state: nextState,
    },
  })
}

/** Read a card by its stable instance id. Returns null if missing/corrupted. */
export async function getPluginCard(cardInstanceId: string): Promise<PluginCard | null> {
  const row = await findMessageByCardInstanceId(cardInstanceId)
  if (!row) return null
  const meta = parseMetadata(row.metadata)
  return meta?.pluginCard ?? null
}

/** Read a card + its hosting agentId, for routes that need to authorize. */
export async function getPluginCardWithOwner(cardInstanceId: string): Promise<{ card: PluginCard; agentId: string; messageId: string } | null> {
  const row = await findMessageByCardInstanceId(cardInstanceId)
  if (!row) return null
  const meta = parseMetadata(row.metadata)
  if (!meta) return null
  return { card: meta.pluginCard, agentId: row.agentId, messageId: row.id }
}

// ─── Lookup helpers ──────────────────────────────────────────────────────────
//
// We index by cardInstanceId by scanning recent system messages. The volume
// of active cards per Agent is small (one per running session at most), so a
// targeted scan is cheap. A dedicated index/table is overkill at V1.

async function findMessageByCardInstanceId(cardInstanceId: string): Promise<{ id: string; agentId: string; metadata: string | null } | null> {
  // Push the substring filter to SQLite so the scan stays cheap even on
  // conversations with deep history. Parse + verify the few candidates in
  // JS to guard against false positives that only happen if the id pattern
  // also appears verbatim in unrelated metadata blobs (extremely unlikely
  // with UUIDs, but the parsing is cheap enough that we keep the check).
  const rows = await db
    .select({ id: messages.id, agentId: messages.agentId, metadata: messages.metadata })
    .from(messages)
    .where(and(
      eq(messages.sourceType, 'system'),
      like(messages.metadata, `%${cardInstanceId}%`),
    ))
    .all()
  for (const row of rows) {
    const meta = parseMetadata(row.metadata)
    if (meta?.pluginCard.cardInstanceId === cardInstanceId) {
      return row
    }
  }
  return null
}
