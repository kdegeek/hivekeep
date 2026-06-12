/**
 * Identity prefix helper for outbound channel messages.
 *
 * Kept in its own module (no DB / adapter imports) so it can be unit-tested in
 * isolation. Bun's `mock.module` is process-global; channel-tools.test.ts mocks
 * `@/server/services/channels`, which would otherwise shadow this pure helper
 * for every other test file in the same run.
 */

/**
 * Prepend a `[Agent Name] ` identity prefix to an outbound text message.
 *
 * Used in two cases:
 *   - identity-switch fallback after a transfer_channel handoff on adapters
 *     that cannot switch identity natively (identitySwitchMode === 'prefix').
 *   - cross-Agent send: an Agent borrows another Agent's channel, so the human needs
 *     to know which Agent is actually speaking through the bot.
 *
 * Idempotent: if the content already starts with `[Name]` it is returned
 * untouched. Empty / whitespace-only content is returned as-is (attachments-only
 * messages do not need an identity hint).
 */
export function applyAgentNamePrefix(content: string, agentName: string): string {
  if (typeof content !== 'string' || content.trim().length === 0) return content
  if (!agentName) return content
  const prefix = `[${agentName}] `
  if (content.startsWith(prefix) || content.startsWith(`[${agentName}]`)) return content
  return `${prefix}${content}`
}
