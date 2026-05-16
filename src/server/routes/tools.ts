import { Hono } from 'hono'
import { toolRegistry } from '@/server/tools/index'
import type { AppVariables } from '@/server/app'
import type { ToolDomain } from '@/shared/types'

/**
 * Tool-level metadata routes. Currently exposes the registry's
 * `name → domain` map so the UI can render tool-call badges and tool
 * settings without duplicating the map on the client. The domain is
 * declared once, at registration time in `src/server/tools/register.ts`.
 */
export const toolsRoutes = new Hono<{ Variables: AppVariables }>()

// GET /api/tools/domains — full registry snapshot of name → domain.
// Plugin tools (registered dynamically) are included so the rendering
// layer can colour their badges correctly too. Cheap call; safe to fetch
// once at app boot and cache for the session.
toolsRoutes.get('/domains', (c) => {
  const map: Record<string, ToolDomain> = {}
  for (const t of toolRegistry.list()) map[t.name] = t.domain
  return c.json(map)
})
