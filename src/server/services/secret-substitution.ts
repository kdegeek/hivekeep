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

export const SECRET_PLACEHOLDER_PATTERN = /\{\{secret:([A-Z][A-Z0-9_]*)(?:\|(base64|urlencode))?\}\}/g

export type SecretTransform = 'base64' | 'urlencode'

/** Apply an optional placeholder transform. Two transforms cover the common
 *  derivations (Basic auth, query-string embedding); anything fancier is a
 *  script reading the secret from the env. */
export function applyTransform(value: string, transform?: SecretTransform): string {
  if (transform === 'base64') return Buffer.from(value, 'utf-8').toString('base64')
  if (transform === 'urlencode') return encodeURIComponent(value)
  return value
}

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

/** Replace each `{{secret:KEY}}` / `{{secret:KEY|transform}}` in every string
 *  leaf with its resolved (optionally transformed) value. Single-pass and
 *  non-recursive by construction: a secret value that itself contains a
 *  placeholder motif is NOT re-expanded (String.replace does not rescan its
 *  own output), so there is no expansion chain to abuse. Unresolved keys are
 *  left verbatim — callers must fail closed before. Transformed values are
 *  noted in the hot cache under their exact placeholder so output redaction
 *  maps them back (a leaked base64 of a secret is still a leak). */
export function substitutePlaceholders(args: unknown, resolved: Map<string, string>): unknown {
  return mapJsonStrings(args, (s) =>
    s.replace(SECRET_PLACEHOLDER_PATTERN, (whole, key: string, transform?: SecretTransform) => {
      const raw = resolved.get(key)
      if (raw === undefined) return whole
      const value = applyTransform(raw, transform)
      if (transform) noteHotValue(whole, value)
      return value
    }),
  )
}

/** Env variable name carrying an expanded secret for `secretsViaEnv` tools.
 *  Vault keys are SCREAMING_SNAKE_CASE so the mapping is direct; transforms
 *  get a suffixed variable (`HIVEKEEP_SECRET_KEY_BASE64`). The prefix is
 *  reserved — documented in the run_shell tool description. */
export function toEnvName(key: string, transform?: SecretTransform): string {
  const suffix = transform === 'base64' ? '_BASE64' : transform === 'urlencode' ? '_URLENC' : ''
  return `HIVEKEEP_SECRET_${key}${suffix}`
}

/** For `secretsViaEnv` tools (run_shell): rewrite each `{{secret:KEY}}` to
 *  `${HIVEKEEP_SECRET_KEY}` so bash expands it from the env at run time —
 *  the value never appears in the command string (ps, history, bash error
 *  messages). Works in double-quoted and bare contexts; single quotes block
 *  expansion by design (taught in the tool description). */
export function rewritePlaceholdersToEnvRefs(args: unknown): unknown {
  return mapJsonStrings(args, (s) =>
    s.replace(SECRET_PLACEHOLDER_PATTERN, (_whole, key: string, transform?: SecretTransform) => `\${${toEnvName(key, transform)}}`),
  )
}

/** Build the env map delivered via `options.secretEnv` — one variable per
 *  (key, transform) pair actually referenced in the original args. */
export function buildSecretEnv(args: unknown, resolved: Map<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  mapJsonStrings(args, (s) => {
    for (const m of s.matchAll(SECRET_PLACEHOLDER_PATTERN)) {
      const [whole, key, transform] = m as unknown as [string, string, SecretTransform | undefined]
      const raw = resolved.get(key)
      if (raw === undefined) continue
      const value = applyTransform(raw, transform)
      if (transform) noteHotValue(whole, value)
      env[toEnvName(key, transform)] = value
    }
    return s
  })
  return env
}

// ─── Hot cache & output redaction ────────────────────────────────────────────

/** Decrypted values of secrets expanded at least once since boot, keyed by
 *  the exact placeholder label (`{{secret:KEY}}`, `{{secret:KEY|base64}}`).
 *  Tool outputs are scanned against this cache (the secret that leaks is
 *  almost always the one just used) — never against the full vault, which
 *  would mean decrypting everything on every tool call. */
const hotSecrets = new Map<string, string>()

export function noteHotSecret(key: string, value: string): void {
  noteHotValue(placeholderFor(key), value)
}

/** Cache a value under its exact placeholder label (raw or transformed). */
export function noteHotValue(label: string, value: string): void {
  if (value.length < MIN_REDACTABLE_SECRET_LENGTH) return
  hotSecrets.set(label, value)
}

/** Invalidate one key (all its labels, transforms included), or the whole
 *  cache when called without arguments (key renames make per-key
 *  invalidation unreliable — clearing is cheap). */
export function invalidateHotSecrets(key?: string): void {
  if (key === undefined) {
    hotSecrets.clear()
    return
  }
  for (const label of [...hotSecrets.keys()]) {
    if (label === placeholderFor(key) || label.startsWith(`{{secret:${key}|`)) hotSecrets.delete(label)
  }
}

/** Replace every known secret value occurring in `s` with its placeholder.
 *  Literal replacement (no regex built from the value), multi-line safe. */
export function redactKnownSecrets(s: string): string {
  let out = s
  for (const [label, value] of hotSecrets) {
    if (out.includes(value)) out = out.replaceAll(value, label)
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

// ─── Host allowlist matching (per-secret scoping, P7) ───────────────────────

/**
 * Does the target URL's hostname match the secret's host allowlist?
 * Entries are either an exact hostname (`api.github.com`) or a wildcard
 * subdomain pattern (`*.github.com` — subdomains only, not the apex).
 * Comparison is case-insensitive on hostname only (ports/paths ignored).
 * Unparseable URLs never match (fail closed).
 */
export function hostMatchesAllowlist(url: string, allowlist: string[]): boolean {
  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  for (const entry of allowlist) {
    const e = entry.trim().toLowerCase()
    if (!e) continue
    if (e.startsWith('*.')) {
      if (hostname.endsWith(e.slice(1)) && hostname.length > e.length - 1) return true
    } else if (hostname === e) {
      return true
    }
  }
  return false
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

// ─── Reveal-carrier sweep (engine) ───────────────────────────────────────────
//
// End-of-turn / boot cleanup for reveal_secret carrier messages. Storage ops
// are injected for the same reason as scrubLeakedValue — secret-redaction.ts
// binds them to drizzle + sseManager.

export interface RevealSweepStore {
  /** Messages flagged redactPending (optionally for one agent). */
  findPendingCarriers(agentId?: string): Promise<Array<{ id: string; agentId: string; metadata: string | null }>>
  /** Full-redact the carrier: set content, isRedacted=true, redactPending=false. */
  redactCarrier(id: string, content: string): Promise<void>
  /** Retroactively scrub this key's value from the whole history. */
  scrubKey(key: string): Promise<void>
  emitRedacted(agentId: string, messageIds: string[]): void
}

/**
 * Redact every reveal carrier: the message holding a raw revealed value is
 * replaced with a neutral note (re-teaching the placeholder), and the value
 * is scrubbed from anything it touched during the turn — the agent may have
 * pasted it into tool arguments, persisted in tool_calls.
 */
export async function sweepRevealedCarriers(store: RevealSweepStore, agentId?: string): Promise<number> {
  const pending = await store.findPendingCarriers(agentId)
  if (pending.length === 0) return 0

  const carriersByAgent = new Map<string, string[]>()
  for (const msg of pending) {
    let revealKey: string | null = null
    try {
      revealKey = (JSON.parse(msg.metadata ?? '{}') as { reveal?: { key?: string } }).reveal?.key ?? null
    } catch { /* metadata unreadable — still redact the carrier below */ }

    await store.redactCarrier(
      msg.id,
      revealKey
        ? `[Secret "${revealKey}" was revealed here with user approval — value redacted. Use the placeholder {{secret:${revealKey}}} from now on.]`
        : '[A revealed secret was redacted.]',
    )

    const list = carriersByAgent.get(msg.agentId) ?? []
    list.push(msg.id)
    carriersByAgent.set(msg.agentId, list)

    if (revealKey) await store.scrubKey(revealKey)
  }

  for (const [aid, messageIds] of carriersByAgent) {
    store.emitRedacted(aid, messageIds)
  }
  return pending.length
}
