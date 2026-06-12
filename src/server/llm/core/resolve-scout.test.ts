/**
 * Tests for the scout-model fallback chain (resolve-scout.ts).
 *
 * Pins the priority order decided 2026-06-12: per-spawn override → PROJECT
 * scout → Agent scout → global default → the Agent's own main model. Project
 * beats Agent, mirroring the main-task chain in createTask (params > project >
 * agent) — only the per-call override outranks a project default.
 *
 * Real in-memory SQLite with only the tables the resolver touches (agents,
 * projects, app_settings — the global tier reads app_settings through the real
 * service, so we do NOT mock.module the widely-imported app-settings module;
 * see the mock-pollution note in tasks-scout-suspend.test.ts).
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import * as schema from '@/server/db/schema'

// Mock pollution guard (mock.module is process-global; see model-registry.test.ts).
const schemaIsReal = !!(schema as { agents?: { id?: unknown } }).agents?.id
const d = schemaIsReal ? describe : describe.skip

const sqlite = new Database(':memory:')
sqlite.run(`CREATE TABLE agents (
  id text PRIMARY KEY NOT NULL,
  model text NOT NULL,
  provider_id text,
  scout_model text,
  scout_provider_id text
)`)
sqlite.run(`CREATE TABLE projects (
  id text PRIMARY KEY NOT NULL,
  scout_model text,
  scout_provider_id text
)`)
sqlite.run(`CREATE TABLE app_settings (
  key text PRIMARY KEY NOT NULL,
  value text NOT NULL,
  updated_at integer NOT NULL
)`)
const testDb = drizzle(sqlite, { schema })
if (schemaIsReal) {
  // Full export surface of '@/server/db/index' (db, sqlite, initVirtualTables) —
  // a partial mock would break later-loaded test files (process-global).
  mock.module('@/server/db/index', () => ({ db: testDb, sqlite, initVirtualTables: () => {} }))
}

const mod = schemaIsReal
  ? await import('@/server/llm/core/resolve-scout')
  : ({} as typeof import('@/server/llm/core/resolve-scout'))
const { resolveScoutModel } = mod

// Real app-settings service (its in-memory cache must stay coherent with our
// table — always go through the setters, never raw SQL on app_settings).
const appSettings = schemaIsReal
  ? await import('@/server/services/app-settings')
  : ({} as typeof import('@/server/services/app-settings'))

const AGENT = 'agent-1'
const PROJECT = 'project-1'

function seed(opts: { agentScout?: string | null; projectScout?: string | null }) {
  sqlite.run(`INSERT INTO agents (id, model, provider_id, scout_model, scout_provider_id)
              VALUES (?, 'agent-main-model', 'prov-main', ?, ?)`,
    [AGENT, opts.agentScout ?? null, opts.agentScout ? 'prov-agent' : null])
  sqlite.run(`INSERT INTO projects (id, scout_model, scout_provider_id)
              VALUES (?, ?, ?)`,
    [PROJECT, opts.projectScout ?? null, opts.projectScout ? 'prov-project' : null])
}

async function setGlobalScout(model: string | null, providerId: string | null) {
  await appSettings.setDefaultScoutModel(model)
  await appSettings.setDefaultScoutProviderId(providerId)
}

beforeEach(async () => {
  if (!schemaIsReal) return
  sqlite.run('DELETE FROM agents')
  sqlite.run('DELETE FROM projects')
  await setGlobalScout(null, null) // clears rows AND the service's cache
})

d('resolveScoutModel priority chain', () => {
  it('per-spawn override beats everything, project included', async () => {
    seed({ agentScout: 'agent-scout', projectScout: 'project-scout' })
    const r = await resolveScoutModel({
      agentId: AGENT,
      projectId: PROJECT,
      override: { modelId: 'override-scout', providerId: 'prov-override' },
    })
    expect(r).toEqual({ modelId: 'override-scout', providerId: 'prov-override' })
  })

  it('PROJECT scout beats the Agent scout', async () => {
    seed({ agentScout: 'agent-scout', projectScout: 'project-scout' })
    const r = await resolveScoutModel({ agentId: AGENT, projectId: PROJECT })
    expect(r).toEqual({ modelId: 'project-scout', providerId: 'prov-project' })
  })

  it('falls back to the Agent scout when the project sets none', async () => {
    seed({ agentScout: 'agent-scout', projectScout: null })
    const r = await resolveScoutModel({ agentId: AGENT, projectId: PROJECT })
    expect(r).toEqual({ modelId: 'agent-scout', providerId: 'prov-agent' })
  })

  it('Agent scout applies outside any project context', async () => {
    seed({ agentScout: 'agent-scout', projectScout: 'project-scout' })
    const r = await resolveScoutModel({ agentId: AGENT, projectId: null })
    expect(r).toEqual({ modelId: 'agent-scout', providerId: 'prov-agent' })
  })

  it('global default when neither project nor Agent set a scout', async () => {
    seed({})
    await setGlobalScout('global-scout', 'prov-global')
    const r = await resolveScoutModel({ agentId: AGENT, projectId: PROJECT })
    expect(r).toEqual({ modelId: 'global-scout', providerId: 'prov-global' })
  })

  it("safety net: the Agent's own main model when nothing is configured", async () => {
    seed({})
    const r = await resolveScoutModel({ agentId: AGENT, projectId: PROJECT })
    expect(r).toEqual({ modelId: 'agent-main-model', providerId: 'prov-main' })
  })

  it('ignores empty-string tiers (treated as unset)', async () => {
    seed({ agentScout: 'agent-scout', projectScout: '  ' })
    const r = await resolveScoutModel({ agentId: AGENT, projectId: PROJECT })
    expect(r).toEqual({ modelId: 'agent-scout', providerId: 'prov-agent' })
  })
})
