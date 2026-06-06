/**
 * Token usage math.
 *
 * `inputTokens` reported by the provider is the GROSS input total
 * (fresh + cache_read + cache_write). The cache portions are in
 * `inputTokenDetails`. We surface the raw token counts and distinguish the
 * tokens that were served from cache (a cache HIT) from those that were not:
 *
 *   cacheHit     = cacheReadTokens
 *   nonCacheHit  = inputTokens - cacheReadTokens   (fresh + cache write)
 *   freshInput   = inputTokens - cacheReadTokens - cacheWriteTokens
 *
 * No weighting is applied — every number is a real token count.
 */

export interface UsageWithCache {
  inputTokens: number
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
}

/**
 * Cache hit rate in [0, 1]: portion of input tokens that came from cache reads.
 */
export function computeCacheHitRate(u: UsageWithCache): number {
  if (!u.inputTokens) return 0
  return Math.min(1, (u.cacheReadTokens ?? 0) / u.inputTokens)
}

/** Fresh (never-cached) input tokens. Negative results are clamped to 0. */
export function computeFreshInput(u: UsageWithCache): number {
  return Math.max(0, (u.inputTokens ?? 0) - (u.cacheReadTokens ?? 0) - (u.cacheWriteTokens ?? 0))
}

/** Input tokens that were NOT served from cache (fresh + cache write).
 *  Negative results are clamped to 0. */
export function computeNonCacheInput(u: UsageWithCache): number {
  return Math.max(0, (u.inputTokens ?? 0) - (u.cacheReadTokens ?? 0))
}
