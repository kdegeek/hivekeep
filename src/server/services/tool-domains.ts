/**
 * Tool domains — dynamic, DB-backed categories used to group tools in the UI
 * (icon + color + label).
 *
 * The 26 built-in domains mirror `TOOL_DOMAIN_META` (shared/constants.ts) and
 * are seeded idempotently at boot (builtin=1, read-only). Users/Agents can create
 * custom domains to organize their custom tools. A domain's `slug` is the
 * stable key referenced by `custom_tools.domain_slug` and by the registry's
 * name→domain map.
 *
 * Visual resolution (see `resolveDomainMeta`):
 *   - builtin → triple (bg/text/border) + labelKey come from TOOL_DOMAIN_META.
 *   - custom  → triple comes from the curated color token (CURATED_DOMAIN_COLORS),
 *               label is the literal DB `label`.
 *
 * Mirrors the toolboxes service (seedBuiltinToolboxes / builtin read-only).
 */

import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { toolDomains, customTools } from '@/server/db/schema'
import { sseManager } from '@/server/sse/index'
import {
  TOOL_DOMAIN_META,
  CURATED_DOMAIN_COLORS,
  DOMAIN_COLOR_TOKENS,
  FALLBACK_DOMAIN_META,
} from '@/shared/constants'
import type { DomainColorToken } from '@/shared/constants'
import type { BuiltinToolDomain, ToolDomainEntry, ToolDomainMetaResolved } from '@/shared/types'
import { createLogger } from '@/server/logger'

const log = createLogger('tool-domains')

/** Slug format for user-created domains: lowercase, digits, hyphens. */
const SLUG_RE = /^[a-z][a-z0-9-]*$/

// ─── Row mapping ────────────────────────────────────────────────────────────────

function rowToDomain(row: typeof toolDomains.$inferSelect): ToolDomainEntry {
  return {
    slug: row.slug,
    label: row.label ?? null,
    labelKey: row.labelKey ?? null,
    icon: row.icon,
    color: row.color ?? null,
    description: row.description ?? null,
    builtin: row.builtin,
    createdAt: row.createdAt.getTime?.() ?? (row.createdAt as unknown as number),
    updatedAt: row.updatedAt.getTime?.() ?? (row.updatedAt as unknown as number),
  }
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export function listToolDomains(): ToolDomainEntry[] {
  return db.select().from(toolDomains).all().map(rowToDomain)
}

export function getToolDomain(slug: string): ToolDomainEntry | null {
  const row = db.select().from(toolDomains).where(eq(toolDomains.slug, slug)).get()
  return row ? rowToDomain(row) : null
}

export function isValidColorToken(token: string): token is DomainColorToken {
  return (DOMAIN_COLOR_TOKENS as readonly string[]).includes(token)
}

export function createToolDomain(input: {
  slug: string
  label: string
  icon: string
  color: string
  description?: string | null
}): ToolDomainEntry {
  const slug = input.slug.trim()
  if (!SLUG_RE.test(slug)) throw new Error('TOOL_DOMAIN_SLUG_INVALID')
  if (getToolDomain(slug)) throw new Error('TOOL_DOMAIN_SLUG_TAKEN')

  const label = input.label.trim()
  if (!label) throw new Error('TOOL_DOMAIN_LABEL_REQUIRED')

  const icon = input.icon.trim()
  if (!icon) throw new Error('TOOL_DOMAIN_ICON_REQUIRED')

  if (!isValidColorToken(input.color)) throw new Error('TOOL_DOMAIN_COLOR_INVALID')

  const now = new Date()
  db.insert(toolDomains)
    .values({
      slug,
      label,
      labelKey: null,
      icon,
      color: input.color,
      description: input.description ?? null,
      builtin: false,
      createdAt: now,
      updatedAt: now,
    })
    .run()

  const created = getToolDomain(slug)
  if (!created) throw new Error('Tool domain creation failed: not found after insert')
  sseManager.broadcast({ type: 'tool-domain:created', data: created as unknown as Record<string, unknown> })
  return created
}

export function updateToolDomain(
  slug: string,
  input: { label?: string; icon?: string; color?: string; description?: string | null },
): ToolDomainEntry {
  const existing = getToolDomain(slug)
  if (!existing) throw new Error('TOOL_DOMAIN_NOT_FOUND')
  if (existing.builtin) throw new Error('TOOL_DOMAIN_BUILTIN_READONLY')

  const patch: Partial<typeof toolDomains.$inferInsert> = { updatedAt: new Date() }

  if (input.label !== undefined) {
    const label = input.label.trim()
    if (!label) throw new Error('TOOL_DOMAIN_LABEL_REQUIRED')
    patch.label = label
  }
  if (input.icon !== undefined) {
    const icon = input.icon.trim()
    if (!icon) throw new Error('TOOL_DOMAIN_ICON_REQUIRED')
    patch.icon = icon
  }
  if (input.color !== undefined) {
    if (!isValidColorToken(input.color)) throw new Error('TOOL_DOMAIN_COLOR_INVALID')
    patch.color = input.color
  }
  if (input.description !== undefined) patch.description = input.description

  db.update(toolDomains).set(patch).where(eq(toolDomains.slug, slug)).run()

  const updated = getToolDomain(slug)
  if (!updated) throw new Error('TOOL_DOMAIN_NOT_FOUND')
  sseManager.broadcast({ type: 'tool-domain:updated', data: updated as unknown as Record<string, unknown> })
  return updated
}

export function deleteToolDomain(slug: string): void {
  const existing = getToolDomain(slug)
  if (!existing) throw new Error('TOOL_DOMAIN_NOT_FOUND')
  if (existing.builtin) throw new Error('TOOL_DOMAIN_BUILTIN_READONLY')

  // Block deletion while in use — reassigning silently would surprise the user.
  const inUse = db.select({ id: customTools.id }).from(customTools).where(eq(customTools.domainSlug, slug)).get()
  if (inUse) throw new Error('TOOL_DOMAIN_IN_USE')

  db.delete(toolDomains).where(eq(toolDomains.slug, slug)).run()
  sseManager.broadcast({ type: 'tool-domain:deleted', data: { slug } })
}

// ─── Resolution (for GET /api/tools/domain-meta) ──────────────────────────────

/**
 * Resolve every domain to its render-ready visual metadata. Builtins keep their
 * bespoke TOOL_DOMAIN_META triple verbatim (preserving special cases like
 * `bg-muted` / `text-accent-foreground` / `/20`); customs resolve via the
 * curated color token, falling back to a neutral default for an unknown token.
 */
export function resolveDomainMeta(): ToolDomainMetaResolved[] {
  return listToolDomains().map((d) => {
    if (d.builtin) {
      const meta = TOOL_DOMAIN_META[d.slug as BuiltinToolDomain] ?? FALLBACK_DOMAIN_META
      return {
        slug: d.slug,
        icon: meta.icon,
        bg: meta.bg,
        text: meta.text,
        border: meta.border,
        builtin: true,
        labelKey: d.labelKey ?? meta.labelKey,
        label: null,
      }
    }
    const triple =
      d.color && isValidColorToken(d.color) ? CURATED_DOMAIN_COLORS[d.color] : FALLBACK_DOMAIN_META
    return {
      slug: d.slug,
      icon: d.icon,
      bg: triple.bg,
      text: triple.text,
      border: triple.border,
      builtin: false,
      labelKey: null,
      label: d.label ?? d.slug,
    }
  })
}

// ─── Seeding ──────────────────────────────────────────────────────────────────

/**
 * Idempotently upsert the 26 built-in tool domains from TOOL_DOMAIN_META.
 * Matched by `slug`. Built-in rows are kept in sync (icon / labelKey refreshed)
 * and flagged builtin=1. Safe to call on every boot. Mirrors
 * `seedBuiltinToolboxes`.
 */
export function seedBuiltinToolDomains(): void {
  const now = new Date()
  let inserted = 0
  let updated = 0

  for (const [slug, meta] of Object.entries(TOOL_DOMAIN_META)) {
    const existing = getToolDomain(slug)

    if (!existing) {
      db.insert(toolDomains)
        .values({
          slug,
          label: null,
          labelKey: meta.labelKey,
          icon: meta.icon,
          color: null,
          description: null,
          builtin: true,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      inserted++
      continue
    }

    const drifted =
      !existing.builtin || existing.icon !== meta.icon || existing.labelKey !== meta.labelKey

    if (drifted) {
      db.update(toolDomains)
        .set({ icon: meta.icon, labelKey: meta.labelKey, builtin: true, updatedAt: now })
        .where(eq(toolDomains.slug, slug))
        .run()
      updated++
    }
  }

  log.info(
    { inserted, updated, total: Object.keys(TOOL_DOMAIN_META).length },
    'Built-in tool domains seeded',
  )
}
