/**
 * Provider slug helpers.
 *
 * Slugs are stable, human-readable identifiers for providers (e.g.
 * "openai-codex", "claude-max-2") used in places where the UUID would be
 * awkward — chiefly tool calls made by Agents (spawn_self, spawn_agent) where
 * the model expresses intent in natural language.
 *
 * Slugs are derived from the provider's `name` at creation time and never
 * change afterwards, so an Agent that remembers `provider_id: "openai-codex"`
 * keeps working even if the user later renames the provider in the UI.
 */

import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { providers } from '@/server/db/schema'
import { createLogger } from '@/server/logger'

const log = createLogger('provider-slug')

/** Maximum slug length — matches GitHub repo-name conventions and keeps
 *  collision suffixes (`-99`) within a comfortable range. */
const MAX_SLUG_LENGTH = 50

/**
 * Convert an arbitrary provider name into a kebab-case slug.
 *
 * - lowercase
 * - strip diacritics (Unicode NFD + remove combining marks)
 * - collapse anything that's not [a-z0-9] into a single dash
 * - trim leading/trailing dashes
 * - truncate to `MAX_SLUG_LENGTH`
 *
 * Returns the literal string "provider" as a last-resort fallback when the
 * input contains no slug-safe characters at all.
 */
export function slugify(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
  return base || 'provider'
}

/**
 * Resolve a slug collision by appending an incrementing `-N` suffix. Pure —
 * caller passes the set of slugs already taken; we return the first free
 * candidate (`base`, then `base-2`, `base-3`, …). The suffix is appended
 * before re-truncating, so very long base slugs may have their tail
 * trimmed to leave room for the suffix.
 */
export function findFreeSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`
    const trimmedBase = base.length + suffix.length > MAX_SLUG_LENGTH
      ? base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/, '')
      : base
    const candidate = `${trimmedBase}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  // Pathological collision (>1000 providers with the same name). Fall back
  // to a random suffix rather than throwing — caller still gets a unique slug.
  return `${base}-${Date.now()}`
}

/** Convenience: read every provider's current slug into a Set. */
export function loadTakenSlugs(): Set<string> {
  const rows = db.select({ slug: providers.slug }).from(providers).all()
  return new Set(rows.map((r) => r.slug).filter((s): s is string => !!s))
}

/**
 * Pick a fresh slug for a brand-new provider given its name. Reads the
 * current set of slugs from the database itself; callers don't need to
 * supply it.
 */
export function generateProviderSlug(name: string): string {
  return findFreeSlug(slugify(name), loadTakenSlugs())
}

/**
 * One-time backfill: rewrite the placeholder slug installed by migration
 * 0071 (which copied the provider's UUID into `slug` so the UNIQUE index
 * could be created) into a proper kebab-case slug derived from the name.
 *
 * Idempotent and cheap to run on every boot — only touches rows whose
 * `slug` still equals their `id` (UUID-shaped).
 */
export async function backfillProviderSlugs(): Promise<void> {
  const rows = db
    .select({ id: providers.id, name: providers.name, slug: providers.slug })
    .from(providers)
    .all()

  const taken = new Set<string>()
  const pending: Array<{ id: string; name: string }> = []
  for (const row of rows) {
    if (row.slug && row.slug !== row.id) {
      taken.add(row.slug)
    } else {
      pending.push({ id: row.id, name: row.name })
    }
  }
  if (pending.length === 0) return

  log.info({ count: pending.length }, 'Backfilling provider slugs (placeholders → derived from name)')
  for (const p of pending) {
    const slug = findFreeSlug(slugify(p.name), taken)
    taken.add(slug)
    db.update(providers).set({ slug }).where(eq(providers.id, p.id)).run()
  }
  log.info({ count: pending.length }, 'Provider slug backfill complete')
}
