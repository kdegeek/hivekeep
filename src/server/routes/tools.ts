import { Hono } from 'hono'
import { toolRegistry } from '@/server/tools/index'
import { HARD_EXCLUDED_FROM_SUBKIN } from '@/server/services/tasks'
import { listAllMCPCatalogTools } from '@/server/services/mcp'
import { listCustomTools } from '@/server/services/custom-tools'
import { db } from '@/server/db/index'
import { kins } from '@/server/db/schema'
import { eq } from 'drizzle-orm'
import { createLogger } from '@/server/logger'
import type { AppVariables } from '@/server/app'
import type { ToolCatalogEntry, ToolDomain } from '@/shared/types'

const log = createLogger('tools-routes')

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

// GET /api/tools/catalog — Kin-agnostic catalog of every grantable tool across
// all four sources (native / plugin / MCP / custom), used to populate the
// toolbox editor. Unlike GET /api/kins/:id/tools this carries no per-Kin
// enabled state — it is a pure metadata listing of what a toolbox can reference
// by name. Nothing is filtered out (it is a catalog); each entry instead
// carries `hardExcludedFromSubKin` so the UI can warn that the tool can never
// run inside a task even if a toolbox lists it (see HARD_EXCLUDED_FROM_SUBKIN
// in services/tasks.ts). `label` is the author-supplied (possibly locale-keyed)
// display label; `description` is the LLM-facing description, best-effort
// extracted from the tool factory (may be absent for some tools).
//
// Sources:
//   - native : registry tools whose name has no `plugin_` prefix.
//   - plugin : registry tools registered under the `plugin_<plugin>_*` prefix.
//   - mcp    : every tool from ALL global active MCP servers (no per-Kin gate),
//              named `mcp_<sanitizeName(server)>_<sanitizeName(tool)>`.
//   - custom : per-Kin scripts — only included when the request carries an
//              optional `?kinId=` (otherwise omitted, since they are not global).
const HARD_EXCLUDED_SET = new Set<string>(HARD_EXCLUDED_FROM_SUBKIN)

/** A registry tool registered by a plugin is prefixed `plugin_<plugin>_` at
 *  activation (see services/plugins.ts). Native tools never carry that prefix,
 *  so the prefix alone distinguishes the two sources reliably. */
function isPluginToolName(name: string): boolean {
  return name.startsWith('plugin_')
}

toolsRoutes.get('/catalog', async (c) => {
  const kinId = c.req.query('kinId')?.trim() || null

  // ── native + plugin (both from the registry) ────────────────────────────────
  const registryEntries: ToolCatalogEntry[] = toolRegistry.list().map((t) => ({
    name: t.name,
    source: isPluginToolName(t.name) ? 'plugin' : 'native',
    domain: t.domain,
    label: t.label ?? null,
    description: toolRegistry.describe(t.name) ?? null,
    defaultDisabled: t.defaultDisabled,
    readOnly: t.readOnly,
    destructive: t.destructive,
    hardExcludedFromSubKin: HARD_EXCLUDED_SET.has(t.name),
  }))

  // ── MCP (all global active servers, no per-Kin gate) ─────────────────────────
  let mcpEntries: ToolCatalogEntry[] = []
  try {
    const mcp = await listAllMCPCatalogTools()
    mcpEntries = mcp.map((m) => ({
      name: m.name,
      source: 'mcp' as const,
      domain: 'mcp' as ToolDomain,
      label: null,
      description: m.description ?? null,
      // MCP tools are always grantable inside tasks (not in the native hard-floor).
      defaultDisabled: false,
      readOnly: false,
      destructive: false,
      hardExcludedFromSubKin: false,
      mcpServerName: m.serverName,
    }))
  } catch (err) {
    // The catalog is best-effort: a flaky MCP server must not take down the
    // toolbox editor. Log and continue with whatever else resolved.
    log.warn({ err }, 'tools/catalog: failed to enumerate MCP tools')
  }

  // ── custom (per-Kin — only when ?kinId= is supplied) ─────────────────────────
  let customEntries: ToolCatalogEntry[] = []
  if (kinId) {
    try {
      const [tools, kin] = await Promise.all([
        listCustomTools(kinId),
        Promise.resolve(db.select({ name: kins.name }).from(kins).where(eq(kins.id, kinId)).get()),
      ])
      const kinName = kin?.name
      customEntries = tools.map((ct) => ({
        name: `custom_${ct.name}`,
        source: 'custom' as const,
        domain: 'custom' as ToolDomain,
        label: null,
        description: ct.description ?? null,
        defaultDisabled: false,
        readOnly: false,
        destructive: false,
        hardExcludedFromSubKin: false,
        customKinId: kinId,
        ...(kinName ? { customKinName: kinName } : {}),
      }))
    } catch (err) {
      log.warn({ err, kinId }, 'tools/catalog: failed to enumerate custom tools')
    }
  }

  const tools: ToolCatalogEntry[] = [...registryEntries, ...mcpEntries, ...customEntries]
  return c.json({ tools })
})
