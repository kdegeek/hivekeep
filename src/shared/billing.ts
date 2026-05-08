/**
 * Billing-related token math.
 *
 * Anthropic prompt caching applies different multipliers to different parts
 * of the input:
 *   - fresh input (not cached) = 1.00× input rate
 *   - cache write (5 min ephemeral) = 1.25× input rate
 *   - cache read = 0.10× input rate (90% discount)
 *   - output = output rate (typically 5× input rate, billed separately)
 *
 * `inputTokens` reported by the Vercel AI SDK is the GROSS input total
 * (fresh + cache_read + cache_write). The cache portions are reported
 * separately under inputTokenDetails. So fresh input must be derived:
 *
 *   freshInput = inputTokens - cacheRead - cacheWrite
 *
 * `computeBillableInput` returns the input-equivalent token count after
 * applying the multipliers — a single comparable number that approximates
 * what the input portion of the call costs, independent of which parts
 * came from cache.
 *
 * Output tokens are kept separate because they have a completely different
 * rate and folding them in would require a model-specific input/output
 * ratio. We keep input and output as two distinct numbers and only
 * normalize the input side.
 */

/** Multiplier for tokens written to the 5-minute ephemeral cache. */
export const CACHE_WRITE_MULTIPLIER = 1.25

/** Multiplier for tokens read from cache (90% discount). */
export const CACHE_READ_MULTIPLIER = 0.1

export interface UsageWithCache {
  inputTokens: number
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
}

/**
 * Compute the billable-input-equivalent token count for a single call or
 * an aggregate. Handles undefined/null cache fields by treating them as 0.
 *
 * Formula: freshInput * 1.00 + cacheWrite * 1.25 + cacheRead * 0.10
 */
export function computeBillableInput(u: UsageWithCache): number {
  const cacheRead = u.cacheReadTokens ?? 0
  const cacheWrite = u.cacheWriteTokens ?? 0
  const freshInput = Math.max(0, (u.inputTokens ?? 0) - cacheRead - cacheWrite)
  return Math.round(
    freshInput
    + cacheWrite * CACHE_WRITE_MULTIPLIER
    + cacheRead * CACHE_READ_MULTIPLIER
  )
}

/**
 * Cache hit rate in [0, 1]: portion of input tokens that came from cache reads.
 * Returns 0 when there are no input tokens or no cache reads.
 */
export function computeCacheHitRate(u: UsageWithCache): number {
  if (!u.inputTokens) return 0
  return Math.min(1, (u.cacheReadTokens ?? 0) / u.inputTokens)
}

/** Fresh (non-cached) input tokens. Negative results are clamped to 0. */
export function computeFreshInput(u: UsageWithCache): number {
  return Math.max(0, (u.inputTokens ?? 0) - (u.cacheReadTokens ?? 0) - (u.cacheWriteTokens ?? 0))
}
