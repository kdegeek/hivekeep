/**
 * Helpers for annotating LLM requests with Anthropic prompt-caching hints.
 *
 * Cache hints are encoded as `cacheControl: { type: 'ephemeral' }` on the
 * individual `HivekeepMessageBlock` carrying the breakpoint. The Anthropic
 * provider promotes those hints to `cache_control` on the matching API
 * block; other providers ignore them.
 *
 * The Anthropic API allows up to 4 cache breakpoints per request. Hivekeep uses:
 *   - end of the stable system segment           (BP1)
 *   - end of the tools list (last tool)          (BP2 — markLastHivekeepToolCacheable)
 *   - last historical message before the new user msg  (BP3 — cross-turn cache)
 *   - very last message of the request           (BP4 — within-turn step cache)
 *
 * The volatile system content (date, memories, current speaker, etc.) is NOT
 * placed as a separate system block — that would split the cacheable prefix
 * into two parts and prevent the historical messages from ever being cached.
 * Instead, the volatile content is wrapped in a `<system-reminder>` block and
 * prepended to the new user message, so it sits AFTER the cacheable prefix.
 *
 * Pattern Anthropic's request looks like (with cache breakpoints):
 *
 *   [stable system, BP1]
 *   [user_1] [assistant_1] [tool_1] ... [assistant_(N-1) last block, BP3]
 *   [user_N: <system-reminder>volatile</system-reminder> + actual content, BP4]
 *
 * Across turns, BP3 grows monotonically (each new turn extends the cached
 * prefix by one assistant/tool message). Within a turn (across tool steps),
 * BP4 ensures successive requests can read each other's cache.
 */
import type {
  HivekeepMessage,
  HivekeepMessageBlock,
  SystemPrompt,
} from '@/server/llm/llm/types'

/**
 * True when no block in the message can carry a cache_control hint.
 * Anthropic rejects `cache_control` on empty text blocks; non-text blocks
 * (image, tool_use, tool_result, thinking) accept it. So a message is
 * "effectively empty" only when all of its blocks are empty text blocks
 * (or the block list is itself empty).
 */
function isEffectivelyEmptyMessage(message: HivekeepMessage): boolean {
  if (message.content.length === 0) return true
  for (const block of message.content) {
    if (block.type === 'text') {
      if (block.text && block.text.length > 0) return false
    } else {
      return false
    }
  }
  return true
}

/**
 * Find the index of the last block that can carry a `cache_control` hint.
 * Prefers a non-empty text block; falls back to image, tool_use, or
 * tool_result blocks when only those are available — useful for tool-loop
 * steps where the last message is a `[{tool-result}]` user turn.
 *
 * Thinking blocks are intentionally skipped: cache hints should anchor on
 * stable, replayed content, and thinking blocks are stripped by some
 * providers in subsequent turns.
 *
 * Returns -1 when no block in the message can carry the hint.
 */
function findCacheAnchorBlockIdx(blocks: readonly HivekeepMessageBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!
    if (b.type === 'text') {
      if (b.text && b.text.length > 0) return i
      continue
    }
    if (b.type === 'thinking') continue
    return i
  }
  return -1
}

/**
 * Return a copy of the message with an `ephemeral` cache_control hint on
 * the block returned by {@link findCacheAnchorBlockIdx}. No-op when the
 * message has no carriable block.
 */
function withCacheBreakpoint(message: HivekeepMessage): HivekeepMessage {
  const idx = findCacheAnchorBlockIdx(message.content)
  if (idx < 0) return message
  const cloned: HivekeepMessageBlock[] = message.content.slice()
  const target = cloned[idx]!
  // findCacheAnchorBlockIdx never returns a thinking block, so the target
  // always has a `cacheControl` field in its type.
  if (target.type === 'text') {
    cloned[idx] = { ...target, cacheControl: { type: 'ephemeral' } }
  } else if (target.type === 'image') {
    cloned[idx] = { ...target, cacheControl: { type: 'ephemeral' } }
  } else if (target.type === 'tool-use') {
    cloned[idx] = { ...target, cacheControl: { type: 'ephemeral' } }
  } else if (target.type === 'tool-result') {
    cloned[idx] = { ...target, cacheControl: { type: 'ephemeral' } }
  }
  return { ...message, content: cloned }
}

/**
 * True when a user message is purely a tool-result reply (no text, image,
 * or other "real" user input). These messages are the user-role wrapper
 * around tool outputs in the Anthropic convention — they are NOT what
 * triggered the current turn.
 */
function isToolResultOnlyMessage(msg: HivekeepMessage): boolean {
  if (msg.role !== 'user') return false
  if (msg.content.length === 0) return false
  for (const block of msg.content) {
    if (block.type !== 'tool-result') return false
  }
  return true
}

/**
 * Find the index of the last "real" user message in a history array.
 * Tool-result-only user messages are skipped — they are responses to the
 * assistant's tool calls, not new user input. Returns -1 when none.
 *
 * Even during a multi-step tool loop, the last real user message is what
 * triggered the current turn, which is where the volatile system reminder
 * must be attached.
 */
function findLastUserMessageIndex(history: readonly HivekeepMessage[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!
    if (msg.role === 'user' && !isToolResultOnlyMessage(msg)) return i
  }
  return -1
}

/**
 * Wrap volatile context as a `<system-reminder>` block and prepend it to a
 * user message's content. Mirrors the convention Claude is trained to
 * handle for runtime hints injected outside the system prompt.
 *
 * Skipped (returns the input unchanged) when the message is not a user
 * message — buildSegmentedMessages ensures this is only called on the
 * last user message.
 */
function prependVolatileToUserMessage(
  msg: HivekeepMessage,
  volatile: string,
): HivekeepMessage {
  if (msg.role !== 'user') return msg
  const reminder = `<system-reminder>\n${volatile}\n</system-reminder>`
  return {
    ...msg,
    content: [{ type: 'text' as const, text: reminder }, ...msg.content],
  }
}

/**
 * Build the request that goes to `LLMProvider.chat()`.
 *
 * Returns:
 *   - `system`: the stable system segment as a single text block carrying
 *     BP1, or `undefined` when the stable segment is empty.
 *   - `messages`: the conversation history with BP3 and BP4 anchored on the
 *     appropriate blocks, and the volatile segment prepended as a
 *     `<system-reminder>` text block on the last user message.
 *
 * Edge cases:
 *   - Empty history: no messages. Volatile is dropped (it must sit AFTER
 *     the cacheable prefix on a user message; there is no user message to
 *     attach it to).
 *   - No volatile content: skip the `<system-reminder>` injection.
 *   - No user message in history (degenerate): treat the last entry as the
 *     "new" message and skip BP3.
 *   - The natural BP3 anchor is an empty-text-only message (e.g. a
 *     sub-Agent row created during `request_input` resume): walk back to a
 *     prior message that has carriable content. Same safety for BP4.
 */
export function buildSegmentedMessages(
  segments: { stable: string; volatile: string },
  history: HivekeepMessage[],
): { system: SystemPrompt | undefined; messages: HivekeepMessage[] } {
  const system: SystemPrompt | undefined = segments.stable
    ? [
        {
          type: 'text',
          text: segments.stable,
          cacheControl: { type: 'ephemeral' },
        },
      ]
    : undefined

  if (history.length === 0) {
    return { system, messages: [] }
  }

  const lastUserIdx = findLastUserMessageIndex(history)
  const out: HivekeepMessage[] = []
  // Index in `out` of the message just BEFORE the new user message.
  // Used as the cross-turn cache breakpoint anchor (BP3).
  let crossTurnAnchorIdx = -1

  for (let i = 0; i < history.length; i++) {
    const msg = history[i]!
    if (i === lastUserIdx && segments.volatile) {
      out.push(prependVolatileToUserMessage(msg, segments.volatile))
    } else {
      out.push(msg)
    }
    if (i === lastUserIdx - 1) {
      crossTurnAnchorIdx = out.length - 1
    }
  }

  // BP3 — cache the prefix up to (but not including) the new user message.
  // This anchor is what grows across turns. Walk back if the natural anchor
  // would have no carriable block.
  let anchorIdx = crossTurnAnchorIdx
  while (anchorIdx >= 0 && isEffectivelyEmptyMessage(out[anchorIdx]!)) {
    anchorIdx--
  }
  if (anchorIdx >= 0) {
    out[anchorIdx] = withCacheBreakpoint(out[anchorIdx]!)
  }

  // BP4 — cache the entire prefix including the new user message. Useful
  // for within-turn step caching (multi-step tool loops re-call chat() with
  // the same prefix plus an appended assistant/tool result). If the last
  // message IS the cross-turn anchor (degenerate single-message history),
  // don't double-mark.
  const lastIdx = out.length - 1
  if (
    lastIdx > 0 &&
    lastIdx !== anchorIdx &&
    !isEffectivelyEmptyMessage(out[lastIdx]!)
  ) {
    out[lastIdx] = withCacheBreakpoint(out[lastIdx]!)
  }

  return { system, messages: out }
}
