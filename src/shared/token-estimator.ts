/**
 * Token estimation that mirrors what providers actually count.
 *
 * Why this exists: a chars/4 heuristic is fine for English prose but is
 * 30-60% too lenient for the JSON / YAML / CLI output that dominates a
 * tool-heavy Agent's history. That under-counting cascaded into:
 *   - The chat banner and visualizer showing 277k while the API received 700k
 *   - The compaction threshold check never firing (estimate < 75% of context
 *     window even though the real prefix was AT the threshold)
 *
 * Switching to a proper BPE tokenizer (OpenAI's tiktoken via gpt-tokenizer)
 * brings the local estimate to within ~5-15% of the real provider count
 * across Anthropic, OpenAI, Google and xAI — vastly better than chars/4.
 *
 * Notes:
 *   - The tokenizer's encoding (`o200k_base`) is OpenAI's, but the BPE
 *     output is close enough to Anthropic / Gemini / Grok in practice.
 *   - Where 100% accuracy matters (per-message billing displays), we use
 *     the exact `inputTokens` returned by the provider after the call —
 *     this estimator is for predictions, not after-the-fact accounting.
 *   - The `gpt-tokenizer` lib is dynamically imported on first call to keep
 *     server cold start cheap (~1 MB worth of merge data otherwise loaded
 *     even when no estimation happens).
 */

let encoderPromise: Promise<{ encode(text: string): number[] }> | null = null

async function loadEncoder(): Promise<{ encode(text: string): number[] }> {
  if (!encoderPromise) {
    encoderPromise = import('gpt-tokenizer/encoding/o200k_base').then((mod) => ({
      encode: (mod.encode as (text: string) => number[]),
    }))
  }
  return encoderPromise
}

/**
 * Synchronous, fast token count.
 *
 * Falls back to chars/4 until the encoder finishes loading on first call —
 * this only ever affects the very first request after a cold start, and
 * the inaccuracy is bounded to that single estimation. Subsequent calls
 * use the loaded encoder.
 */
export function countTokens(text: string): number {
  if (!text) return 0
  const encoder = encoderPromiseToSync()
  if (encoder) return encoder.encode(text).length
  // Pre-load fallback: kick the lazy import on first call so the next one is fast
  void loadEncoder()
  return Math.ceil(text.length / 4)
}

let cachedSyncEncoder: { encode(text: string): number[] } | null = null

function encoderPromiseToSync(): { encode(text: string): number[] } | null {
  if (cachedSyncEncoder) return cachedSyncEncoder
  // Try to read the resolved value from the cached promise. If it hasn't
  // resolved yet, return null and the caller will use the fallback.
  if (encoderPromise && (encoderPromise as Promise<unknown> & { __resolved?: { encode(text: string): number[] } }).__resolved) {
    cachedSyncEncoder = (encoderPromise as Promise<unknown> & { __resolved: { encode(text: string): number[] } }).__resolved
    return cachedSyncEncoder
  }
  return null
}

/**
 * Async token count — preferred when the caller can await. Always uses the
 * loaded BPE encoder, no chars/4 fallback.
 */
export async function countTokensAsync(text: string): Promise<number> {
  if (!text) return 0
  const encoder = await loadEncoder()
  // Stash for synchronous callers that come after.
  cachedSyncEncoder = encoder
  // Mark the promise as resolved so encoderPromiseToSync sees it.
  if (encoderPromise) {
    Object.defineProperty(encoderPromise, '__resolved', { value: encoder, configurable: true })
  }
  return encoder.encode(text).length
}

/**
 * Eagerly load the encoder so synchronous countTokens calls hit the BPE
 * path immediately. Call once at server startup.
 */
export async function preloadTokenizer(): Promise<void> {
  await countTokensAsync('warmup')
}
