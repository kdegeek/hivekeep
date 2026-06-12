import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { agents } from '@/server/db/schema'
import { isUUID } from '@/server/utils/slug'

/**
 * Resolve an agent by either UUID or slug.
 * Returns the full agent row or undefined.
 */
export function resolveAgentByIdOrSlug(idOrSlug: string) {
  if (isUUID(idOrSlug)) {
    return db.select().from(agents).where(eq(agents.id, idOrSlug)).get()
  }
  return db.select().from(agents).where(eq(agents.slug, idOrSlug)).get()
}

/**
 * Resolve a slug or UUID to an agent UUID.
 * Returns the UUID or null if not found.
 */
export function resolveAgentId(idOrSlug: string): string | null {
  if (isUUID(idOrSlug)) return idOrSlug
  const agent = db.select({ id: agents.id }).from(agents).where(eq(agents.slug, idOrSlug)).get()
  return agent?.id ?? null
}
