/**
 * Integration tests for the model registry reconciliation against a real
 * in-memory SQLite DB (the heart of phase 1). Uses the bundled models.dev
 * snapshot for matching, so the assertions also pin the real seed data.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import * as schema from '@/server/db/schema'

// Some earlier test files stub `@/server/db/schema` via mock.module (every table
// becomes `{}`). When this file runs after one of those, the static
// `import { modelRegistry } from schema` inside the SUT throws. Detect pollution
// and skip cleanly — same pattern as ticket-comments.test.ts.
const schemaIsReal = !!(schema as { modelRegistry?: { id?: unknown } }).modelRegistry?.id
const d = schemaIsReal ? describe : describe.skip

mock.module('@/server/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }),
}))

const sqlite = new Database(':memory:')
// Only the table under test — no FK enforcement so we don't need a providers row.
sqlite.run(`CREATE TABLE model_registry (
  id text PRIMARY KEY NOT NULL,
  provider_id text NOT NULL,
  model_id text NOT NULL,
  display_name text,
  mapping_mode text DEFAULT 'auto' NOT NULL,
  models_dev_key text,
  match_confidence text,
  context_window integer,
  max_output integer,
  supports_tool_call integer,
  supports_image_input integer,
  supports_pdf_input integer,
  reasoning text,
  pricing text,
  overridden_fields text,
  enabled integer DEFAULT true NOT NULL,
  needs_review integer DEFAULT false NOT NULL,
  stale integer DEFAULT false NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
)`)
const testDb = drizzle(sqlite, { schema })
mock.module('@/server/db/index', () => ({ db: testDb, sqlite }))

// Only load the SUT when the schema is real — a polluted schema makes the SUT's
// static `modelRegistry` import throw at module eval.
const reg = schemaIsReal
  ? await import('@/server/services/model-registry')
  : ({} as typeof import('@/server/services/model-registry'))
const { reconcileProviderModels, getRegistryRow, listRegistryByProvider, rowToMetadata, updateRegistryModel, remapModel, setMappingMode, resetModelToAuto } = reg
const modelRegistry = (schema as typeof import('@/server/db/schema')).modelRegistry

const PROVIDER = 'provider-uuid-1'

beforeEach(() => {
  if (schemaIsReal) testDb.delete(modelRegistry).run()
})

d('reconcileProviderModels', () => {
  it('seeds a matched model: API value wins, models.dev fills the gaps (pricing)', () => {
    // deepseek provider sets context + thinking; does NOT set pricing.
    reconcileProviderModels(PROVIDER, 'deepseek', [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1_000_000, thinking: { efforts: ['low', 'medium', 'high', 'max'] } },
    ])
    const row = getRegistryRow(PROVIDER, 'deepseek-v4-flash')!
    expect(row.contextWindow).toBe(1_000_000) // apiSeed
    expect(row.supportsImageInput).toBe(false) // filled from models.dev (input:[text])
    expect(row.modelsDevKey).toBe('deepseek/deepseek-v4-flash')
    expect(row.matchConfidence).toBe('exact')
    expect(row.needsReview).toBe(false)
    expect(row.stale).toBe(false)
    expect(JSON.parse(row.pricing!)).toEqual({ input: 0.14, output: 0.28, cacheRead: 0.0028 }) // models.dev
    expect(JSON.parse(row.reasoning!)).toEqual({ enabled: true, efforts: ['low', 'medium', 'high', 'max'] })
  })

  it('flags an unmatched model for review (no models.dev entry)', () => {
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'deepseek-mystery-x', name: 'Mystery', contextWindow: 64_000 }])
    const row = getRegistryRow(PROVIDER, 'deepseek-mystery-x')!
    expect(row.contextWindow).toBe(64_000) // apiSeed only
    expect(row.modelsDevKey).toBeNull()
    expect(row.matchConfidence).toBe('none')
    expect(row.needsReview).toBe(true)
  })

  it('marks a disappeared model as stale (not deleted)', () => {
    reconcileProviderModels(PROVIDER, 'deepseek', [
      { id: 'deepseek-v4-flash', name: 'a' },
      { id: 'deepseek-v4-pro', name: 'b' },
    ])
    expect(listRegistryByProvider(PROVIDER)).toHaveLength(2)
    // pro disappears from the live list
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'deepseek-v4-flash', name: 'a' }])
    expect(getRegistryRow(PROVIDER, 'deepseek-v4-pro')!.stale).toBe(true)
    expect(getRegistryRow(PROVIDER, 'deepseek-v4-flash')!.stale).toBe(false)
    expect(listRegistryByProvider(PROVIDER)).toHaveLength(2) // not deleted
  })

  it('preserves admin-pinned fields across re-reconcile', () => {
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'deepseek-v4-flash', name: 'DS', contextWindow: 1_000_000 }])
    const row = getRegistryRow(PROVIDER, 'deepseek-v4-flash')!
    // Admin pins a custom context window (raw UPDATE keeps the test drizzle-free).
    sqlite.run(`UPDATE model_registry SET context_window=200000, overridden_fields='["contextWindow"]' WHERE id=?`, [row.id])
    // Re-reconcile with a different live context — the pinned field must survive.
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'deepseek-v4-flash', name: 'DS', contextWindow: 999_999 }])
    expect(getRegistryRow(PROVIDER, 'deepseek-v4-flash')!.contextWindow).toBe(200_000)
  })

  it('freezes a manual-mode row entirely', () => {
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'deepseek-v4-flash', name: 'DS', contextWindow: 1_000_000 }])
    const row = getRegistryRow(PROVIDER, 'deepseek-v4-flash')!
    sqlite.run(`UPDATE model_registry SET mapping_mode='manual', context_window=123 WHERE id=?`, [row.id])
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'deepseek-v4-flash', name: 'DS', contextWindow: 999_999 }])
    expect(getRegistryRow(PROVIDER, 'deepseek-v4-flash')!.contextWindow).toBe(123)
  })
})

d('rowToMetadata', () => {
  it('round-trips columns back into resolved metadata', () => {
    reconcileProviderModels(PROVIDER, 'minimax', [{ id: 'MiniMax-M3', name: 'MiniMax-M3' }])
    const md = rowToMetadata(getRegistryRow(PROVIDER, 'MiniMax-M3')!)
    expect(md.contextWindow).toBe(512_000) // from models.dev
    expect(md.supportsImageInput).toBe(true)
    expect(md.supportsPdfInput).toBe(false)
    expect(md.thinking).toEqual({ efforts: [] }) // reasoning toggle-only
  })
})

d('admin edits (Models view)', () => {
  it('pins an edited field so it survives re-reconcile', () => {
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'deepseek-v4-flash', name: 'DS', contextWindow: 1_000_000 }])
    const id = getRegistryRow(PROVIDER, 'deepseek-v4-flash')!.id
    updateRegistryModel(id, { contextWindow: 50_000 })
    let row = getRegistryRow(PROVIDER, 'deepseek-v4-flash')!
    expect(row.contextWindow).toBe(50_000)
    expect(JSON.parse(row.overriddenFields!)).toContain('contextWindow')
    // resync must NOT clobber the pinned value
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'deepseek-v4-flash', name: 'DS', contextWindow: 1_000_000 }])
    row = getRegistryRow(PROVIDER, 'deepseek-v4-flash')!
    expect(row.contextWindow).toBe(50_000)
  })

  it('remaps an unmatched model onto a models.dev entry', () => {
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'weird-alias', name: 'Weird' }])
    const id = getRegistryRow(PROVIDER, 'weird-alias')!.id
    expect(getRegistryRow(PROVIDER, 'weird-alias')!.needsReview).toBe(true)
    remapModel(id, 'deepseek/deepseek-v4-flash')
    const row = getRegistryRow(PROVIDER, 'weird-alias')!
    expect(row.modelsDevKey).toBe('deepseek/deepseek-v4-flash')
    expect(row.needsReview).toBe(false)
    expect(row.contextWindow).toBe(1_000_000) // pulled from models.dev
    expect(JSON.parse(row.pricing!).input).toBe(0.14)
  })

  it('freezes a row set to manual mode', () => {
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'deepseek-v4-flash', name: 'DS', contextWindow: 1_000_000 }])
    const id = getRegistryRow(PROVIDER, 'deepseek-v4-flash')!.id
    setMappingMode(id, 'manual')
    updateRegistryModel(id, { contextWindow: 7 })
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'deepseek-v4-flash', name: 'DS', contextWindow: 1_000_000 }])
    expect(getRegistryRow(PROVIDER, 'deepseek-v4-flash')!.contextWindow).toBe(7)
  })

  it('clears needsReview on save and pins nothing for an empty patch', () => {
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'weird-alias', name: 'Weird' }])
    const id = getRegistryRow(PROVIDER, 'weird-alias')!.id
    expect(getRegistryRow(PROVIDER, 'weird-alias')!.needsReview).toBe(true)
    updateRegistryModel(id, {}) // no-op save = "I looked at it"
    const row = getRegistryRow(PROVIDER, 'weird-alias')!
    expect(row.needsReview).toBe(false)
    expect(JSON.parse(row.overriddenFields!)).toEqual([])
  })

  it('resetModelToAuto drops every pin, returns to auto, and re-derives from models.dev', () => {
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'deepseek-v4-flash', name: 'DS', contextWindow: 1_000_000 }])
    const id = getRegistryRow(PROVIDER, 'deepseek-v4-flash')!.id
    updateRegistryModel(id, { contextWindow: 42, displayName: 'My Custom Label' })
    setMappingMode(id, 'manual')
    expect(JSON.parse(getRegistryRow(PROVIDER, 'deepseek-v4-flash')!.overriddenFields!).length).toBeGreaterThan(0)

    resetModelToAuto(id)
    const row = getRegistryRow(PROVIDER, 'deepseek-v4-flash')!
    expect(row.mappingMode).toBe('auto')
    expect(JSON.parse(row.overriddenFields!)).toEqual([])
    expect(row.contextWindow).toBe(1_000_000) // back to the models.dev value
    expect(row.displayName).not.toBe('My Custom Label') // custom label dropped
    expect(row.needsReview).toBe(false)
  })
})
