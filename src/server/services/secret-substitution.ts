/**
 * Secret placeholder substitution — the core of the vault-placeholders system
 * (see vault-placeholders.md).
 *
 * Agents reference secrets as `{{secret:KEY}}` in tool arguments. Just before
 * a tool executes, the tool-executor expands placeholders to the real vault
 * value (input direction); just after, it scans the result for known secret
 * values and replaces them with their placeholder (output direction). The raw
 * value never enters LLM context, persisted messages, or SSE events — they
 * all carry the placeholder.
 *
 * This module is deliberately vault-agnostic (no import of services/vault):
 * resolution takes a getter so vault.ts can import the helpers here without
 * creating an import cycle, and so the pure functions are trivially testable.
 */

export const SECRET_PLACEHOLDER_PATTERN = /\{\{secret:([A-Z][A-Z0-9_]*)\}\}/g

/** Secrets shorter than this are never scanned for in tool outputs — the
 *  false-positive rate on tiny strings would shred legitimate output. The
 *  same floor applies to retroactive redaction (redact_secret_leak). */
export const MIN_REDACTABLE_SECRET_LENGTH = 6

export function placeholderFor(key: string): string {
  return `{{secret:${key}}}`
}

/**
 * Deep-map every string leaf of a plain-JSON value through `fn`, returning a
 * NEW structure — the input is never mutated (persisted tool args/results
 * must keep their original form). Non-plain objects (class instances, typed
 * arrays) are returned as-is rather than mangled through Object.entries.
 */
export function mapJsonStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map((v) => mapJsonStrings(v, fn))
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = mapJsonStrings(v, fn)
    return out
  }
  return value
}

/** Collect the unique placeholder keys referenced anywhere in `value`. */
export function extractPlaceholderKeys(value: unknown): string[] {
  const keys = new Set<string>()
  mapJsonStrings(value, (s) => {
    for (const m of s.matchAll(SECRET_PLACEHOLDER_PATTERN)) keys.add(m[1]!)
    return s
  })
  return [...keys]
}

/**
 * Resolve every key through `getValue` (the vault getter). Missing keys are
 * reported, not thrown — the executor fails the tool call closed with an
 * actionable error instead of executing with a literal placeholder.
 * Resolved values feed the hot cache for output redaction.
 */
export async function resolvePlaceholderSecrets(
  keys: string[],
  getValue: (key: string) => Promise<string | null>,
): Promise<{ resolved: Map<string, string>; missing: string[] }> {
  const resolved = new Map<string, string>()
  const missing: string[] = []
  for (const key of keys) {
    const value = await getValue(key)
    if (value === null) {
      missing.push(key)
    } else {
      resolved.set(key, value)
      noteHotSecret(key, value)
    }
  }
  return { resolved, missing }
}

/** Replace each `{{secret:KEY}}` in every string leaf with its resolved
 *  value. Single-pass and non-recursive by construction: a secret value that
 *  itself contains a placeholder motif is NOT re-expanded (String.replace
 *  does not rescan its own output), so there is no expansion chain to abuse.
 *  Unresolved keys are left verbatim — callers must fail closed before. */
export function substitutePlaceholders(args: unknown, resolved: Map<string, string>): unknown {
  return mapJsonStrings(args, (s) =>
    s.replace(SECRET_PLACEHOLDER_PATTERN, (whole, key: string) => resolved.get(key) ?? whole),
  )
}

/** Env variable name carrying an expanded secret for `secretsViaEnv` tools.
 *  Vault keys are SCREAMING_SNAKE_CASE so the mapping is direct. The prefix
 *  is reserved — documented in the run_shell tool description. */
export function toEnvName(key: string): string {
  return `HIVEKEEP_SECRET_${key}`
}

/** For `secretsViaEnv` tools (run_shell): rewrite each `{{secret:KEY}}` to
 *  `${HIVEKEEP_SECRET_KEY}` so bash expands it from the env at run time —
 *  the value never appears in the command string (ps, history, bash error
 *  messages). Works in double-quoted and bare contexts; single quotes block
 *  expansion by design (taught in the tool description). */
export function rewritePlaceholdersToEnvRefs(args: unknown): unknown {
  return mapJsonStrings(args, (s) =>
    s.replace(SECRET_PLACEHOLDER_PATTERN, (_whole, key: string) => `\${${toEnvName(key)}}`),
  )
}

/** Build the env map delivered via `options.secretEnv`. */
export function buildSecretEnv(resolved: Map<string, string>): Record<string, string> {
  return Object.fromEntries([...resolved].map(([key, value]) => [toEnvName(key), value]))
}

// ─── Hot cache & output redaction ────────────────────────────────────────────

/** Decrypted values of secrets expanded at least once since boot, keyed by
 *  vault key. Tool outputs are scanned against this cache (the secret that
 *  leaks is almost always the one just used) — never against the full vault,
 *  which would mean decrypting everything on every tool call. */
const hotSecrets = new Map<string, string>()

export function noteHotSecret(key: string, value: string): void {
  if (value.length < MIN_REDACTABLE_SECRET_LENGTH) return
  hotSecrets.set(key, value)
}

/** Invalidate one key, or the whole cache when called without arguments
 *  (key renames make per-key invalidation unreliable — clearing is cheap). */
export function invalidateHotSecrets(key?: string): void {
  if (key === undefined) hotSecrets.clear()
  else hotSecrets.delete(key)
}

/** Replace every known secret value occurring in `s` with its placeholder.
 *  Literal replacement (no regex built from the value), multi-line safe. */
export function redactKnownSecrets(s: string): string {
  let out = s
  for (const [key, value] of hotSecrets) {
    if (out.includes(value)) out = out.replaceAll(value, placeholderFor(key))
  }
  return out
}

/** Output-direction redaction: scan a tool result (string leaves, including
 *  error fields) for hot secret values. No-op when the cache is empty, so
 *  the common case costs nothing. */
export function redactSecretsInResult(result: unknown): unknown {
  if (hotSecrets.size === 0) return result
  return mapJsonStrings(result, redactKnownSecrets)
}

export function hotSecretCount(): number {
  return hotSecrets.size
}

// ─── Retroactive leak scrubbing (engine) ─────────────────────────────────────
//
// The storage-agnostic core of `redact_secret_leak`. Lives here with injected
// deps so the tricky parts (LIKE escaping, the JSON-escaped prefilter form,
// the surgical walk of tool_calls JSON) are testable without the DB/SSE
// modules — secret-redaction.ts binds it to drizzle + sseManager.

/** Escape SQLite LIKE wildcards so a secret value can be used as a literal
 *  pattern (paired with `ESCAPE '\'`). */
export function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&')
}

export interface LeakScrubStore {
  /** Messages whose content matches `contentPattern` OR whose tool_calls
   *  JSON matches `toolCallsPattern` (both `LIKE … ESCAPE '\'`). */
  findCandidateMessages(
    contentPattern: string,
    toolCallsPattern: string,
  ): Promise<Array<{ id: string; agentId: string; content: string | null; toolCalls: string | null }>>
  updateMessage(id: string, updates: { content?: string; toolCalls?: string }): Promise<void>
  findCandidateSummaries(contentPattern: string): Promise<Array<{ id: string; summary: string }>>
  updateSummary(id: string, summary: string): Promise<void>
  /** Notify clients that these messages changed in place (per agent). */
  emitRedacted(agentId: string, messageIds: string[]): void
}

/**
 * Replace every occurrence of `value` with the `{{secret:KEY}}` placeholder
 * across message content, tool_calls JSON, and compacting summaries.
 * Surgical: untouched parts of each row survive.
 */
export async function scrubLeakedValue(
  key: string,
  value: string,
  store: LeakScrubStore,
): Promise<{ messagesCleaned: number; summariesCleaned: number }> {
  const placeholder = placeholderFor(key)
  // Inside the tool_calls JSON text the value appears in its JSON-escaped
  // form (quotes/backslashes/newlines escaped) — prefilter with that form,
  // then parse + walk for the actual replacement.
  const jsonEscapedValue = JSON.stringify(value).slice(1, -1)
  const contentPattern = `%${escapeLikePattern(value)}%`
  const toolCallsPattern = `%${escapeLikePattern(jsonEscapedValue)}%`

  const candidates = await store.findCandidateMessages(contentPattern, toolCallsPattern)
  const cleanedByAgent = new Map<string, string[]>()

  for (const msg of candidates) {
    const updates: { content?: string; toolCalls?: string } = {}

    if (msg.content?.includes(value)) {
      updates.content = msg.content.replaceAll(value, placeholder)
    }

    if (msg.toolCalls?.includes(jsonEscapedValue)) {
      try {
        const parsed = JSON.parse(msg.toolCalls)
        const scrubbed = mapJsonStrings(parsed, (s) => (s.includes(value) ? s.replaceAll(value, placeholder) : s))
        updates.toolCalls = JSON.stringify(scrubbed)
      } catch {
        // Malformed JSON (shouldn't happen) — degrade to a raw text replace
        // of the escaped form rather than leaving the secret in place.
        updates.toolCalls = msg.toolCalls.replaceAll(jsonEscapedValue, placeholder)
      }
    }

    if (Object.keys(updates).length === 0) continue
    await store.updateMessage(msg.id, updates)
    const list = cleanedByAgent.get(msg.agentId) ?? []
    list.push(msg.id)
    cleanedByAgent.set(msg.agentId, list)
  }

  const summaryRows = await store.findCandidateSummaries(contentPattern)
  for (const row of summaryRows) {
    await store.updateSummary(row.id, row.summary.replaceAll(value, placeholder))
  }

  for (const [agentId, messageIds] of cleanedByAgent) {
    store.emitRedacted(agentId, messageIds)
  }

  const messagesCleaned = [...cleanedByAgent.values()].reduce((n, ids) => n + ids.length, 0)
  return { messagesCleaned, summariesCleaned: summaryRows.length }
}
