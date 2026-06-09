/**
 * Model registry repository — the source of truth for per-model metadata.
 *
 * One row per (provider, upstream model id). Rows are seeded/reconciled from the
 * provider's live `listModels()` output (API seed) + the bundled models.dev
 * snapshot, with admin overrides pinned on top. The effective value per field is
 * computed at RECONCILE time and stored in the column, so a row reads back as the
 * exact value the resolver uses (priority: pinned admin > provider-API seed >
 * models.dev > default/unknown). See `model-metadata.md`.
 *
 * Pure DB access — the SEAM enrichment (`enrich.ts`) and the API/UI build on top.
 * Everything here is gated by the caller; this module never checks the flag.
 */

import { and, eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { modelRegistry, providers as providersTable } from '@/server/db/schema'
import { resolveFromModelsDev, type MatchConfidence, type ResolvedModelMetadata } from '@/server/llm/metadata/models-dev'
import { getLLMProvider } from '@/server/llm/llm/registry'
import { loadProviderConfig } from '@/server/services/provider-config'
import { createLogger } from '@/server/logger'
import type { LLMModel, ThinkingEffort } from '@/server/llm/llm/types'

const log = createLogger('model-registry')

type Row = typeof modelRegistry.$inferSelect

/** Fields the registry owns (must match ResolvedModelMetadata keys + columns). */
const PINNABLE_FIELDS = [
  'contextWindow',
  'maxOutput',
  'supportsImageInput',
  'supportsPdfInput',
  'supportsToolCall',
  'thinking',
  'pricing',
] as const
export type RegistryField = (typeof PINNABLE_FIELDS)[number]

// ─── metadata <-> row columns ─────────────────────────────────────────────────

/** Extract the metadata fields a provider's `listModels()` genuinely populated. */
export function apiSeedFromModel(model: LLMModel): ResolvedModelMetadata {
  const out: ResolvedModelMetadata = {}
  if (model.contextWindow != null) out.contextWindow = model.contextWindow
  if (model.maxOutput != null) out.maxOutput = model.maxOutput
  if (model.supportsImageInput != null) out.supportsImageInput = model.supportsImageInput
  if (model.supportsPdfInput != null) out.supportsPdfInput = model.supportsPdfInput
  // The LLMModel carries tool-calling as `maxTools` (0 = none); only 0 is a
  // definite "no tool call" signal — anything else inherits the provider default.
  if (model.maxTools === 0) out.supportsToolCall = false
  if (model.thinking) out.thinking = { efforts: model.thinking.efforts }
  if (model.pricing) {
    out.pricing = {
      input: model.pricing.input,
      output: model.pricing.output,
      ...(model.pricing.cacheRead != null ? { cacheRead: model.pricing.cacheRead } : {}),
      ...(model.pricing.cacheWrite != null ? { cacheWrite: model.pricing.cacheWrite } : {}),
    }
  }
  return out
}

/** Per-field merge (first defined wins) — used to bake the auto value at reconcile. */
function mergeSeed(...layers: Array<ResolvedModelMetadata | null | undefined>): ResolvedModelMetadata {
  const out: ResolvedModelMetadata = {}
  for (const f of PINNABLE_FIELDS) {
    for (const layer of layers) {
      if (layer && layer[f] !== undefined) {
        ;(out as Record<string, unknown>)[f] = layer[f]
        break
      }
    }
  }
  return out
}

/** Parse a registry row back into resolved metadata (columns already hold the
 *  effective value: pinned override or reconciled auto). */
export function rowToMetadata(row: Row): ResolvedModelMetadata {
  const out: ResolvedModelMetadata = {}
  if (row.contextWindow != null) out.contextWindow = row.contextWindow
  if (row.maxOutput != null) out.maxOutput = row.maxOutput
  if (row.supportsImageInput != null) out.supportsImageInput = row.supportsImageInput
  if (row.supportsPdfInput != null) out.supportsPdfInput = row.supportsPdfInput
  if (row.supportsToolCall != null) out.supportsToolCall = row.supportsToolCall
  if (row.reasoning) {
    try {
      const r = JSON.parse(row.reasoning) as { enabled?: boolean; efforts?: string[] }
      if (r.enabled) out.thinking = { efforts: (r.efforts ?? []) as ThinkingEffort[] }
    } catch { /* ignore corrupt JSON */ }
  }
  if (row.pricing) {
    try {
      out.pricing = JSON.parse(row.pricing) as ResolvedModelMetadata['pricing']
    } catch { /* ignore */ }
  }
  return out
}

/** Serialize metadata into the column values for an insert/update. */
function metadataToColumns(meta: ResolvedModelMetadata): Partial<Row> {
  const cols: Partial<Row> = {}
  cols.contextWindow = meta.contextWindow ?? null
  cols.maxOutput = meta.maxOutput ?? null
  cols.supportsImageInput = meta.supportsImageInput ?? null
  cols.supportsPdfInput = meta.supportsPdfInput ?? null
  cols.supportsToolCall = meta.supportsToolCall ?? null
  cols.reasoning = meta.thinking
    ? JSON.stringify({ enabled: true, efforts: meta.thinking.efforts })
    : null
  cols.pricing = meta.pricing ? JSON.stringify(meta.pricing) : null
  return cols
}

// ─── reads ─────────────────────────────────────────────────────────────────────

export function getRegistryRow(providerId: string, modelId: string): Row | undefined {
  return db
    .select()
    .from(modelRegistry)
    .where(and(eq(modelRegistry.providerId, providerId), eq(modelRegistry.modelId, modelId)))
    .get()
}

export function listRegistry(): Row[] {
  return db.select().from(modelRegistry).all()
}

export function listRegistryByProvider(providerId: string): Row[] {
  return db.select().from(modelRegistry).where(eq(modelRegistry.providerId, providerId)).all()
}

// ─── reconciliation (seed + resync + new-model discovery + staleness) ───────────

/**
 * Reconcile a provider's live model list against the registry:
 * - new id → insert an `auto` row, best-effort matched to models.dev (apiSeed >
 *   models.dev), flagged `needsReview` when the match is low-confidence/absent.
 * - known id → refresh non-pinned `auto` fields (manual rows + pinned fields
 *   untouched); clear `stale`.
 * - id no longer present → mark `stale` (never delete — preserves overrides).
 */
export function reconcileProviderModels(
  providerId: string,
  providerType: string,
  liveModels: LLMModel[],
): void {
  const now = new Date()
  const existing = listRegistryByProvider(providerId)
  const existingById = new Map(existing.map((r) => [r.modelId, r]))
  const liveIds = new Set(liveModels.map((m) => m.id))

  for (const model of liveModels) {
    const md = resolveFromModelsDev(providerType, model.id)
    const apiSeed = apiSeedFromModel(model)
    const auto = mergeSeed(apiSeed, md?.metadata)
    const matchKey = md?.match.key ?? null
    const confidence: MatchConfidence = md?.match.confidence ?? 'none'
    const needsReview = confidence === 'family' || confidence === 'none'

    const row = existingById.get(model.id)
    if (!row) {
      db.insert(modelRegistry)
        .values({
          id: crypto.randomUUID(),
          providerId,
          modelId: model.id,
          displayName: model.name ?? model.id,
          mappingMode: 'auto',
          modelsDevKey: matchKey,
          matchConfidence: confidence,
          ...metadataToColumns(auto),
          overriddenFields: '[]',
          enabled: true,
          needsReview,
          stale: false,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      continue
    }

    // Existing row. Manual rows are frozen; auto rows refresh non-pinned fields.
    if (row.mappingMode === 'manual') {
      if (row.stale) db.update(modelRegistry).set({ stale: false, updatedAt: now }).where(eq(modelRegistry.id, row.id)).run()
      continue
    }
    const pinned = new Set<string>(safeParseArray(row.overriddenFields))
    const recomputed = metadataToColumns(auto)
    const patch: Partial<Row> = { stale: false, updatedAt: now, matchConfidence: confidence, modelsDevKey: matchKey }
    for (const f of PINNABLE_FIELDS) {
      if (pinned.has(f)) continue // keep admin-pinned value
      if (f === 'thinking') patch.reasoning = recomputed.reasoning ?? null
      else if (f === 'pricing') patch.pricing = recomputed.pricing ?? null
      else (patch as Record<string, unknown>)[f] = (recomputed as Record<string, unknown>)[f] ?? null
    }
    db.update(modelRegistry).set(patch).where(eq(modelRegistry.id, row.id)).run()
  }

  // Mark rows whose model disappeared from the provider as stale.
  for (const row of existing) {
    if (!liveIds.has(row.modelId) && !row.stale) {
      db.update(modelRegistry).set({ stale: true, updatedAt: now }).where(eq(modelRegistry.id, row.id)).run()
    }
  }
  log.debug({ providerId, providerType, live: liveModels.length }, 'Reconciled provider models')
}

/**
 * Reconcile every valid LLM provider against the registry. Lists each provider's
 * models live (raw, full metadata) and reconciles. Used by the periodic cron and
 * after a provider is (re)validated. Per-provider errors are logged, not thrown.
 */
export async function reconcileAllProviders(): Promise<void> {
  const rows = db.select().from(providersTable).all()
  for (const p of rows) {
    if (!p.isValid) continue
    const llm = getLLMProvider(p.type)
    if (!llm) continue
    let caps: string[] = []
    try {
      caps = JSON.parse(p.capabilities) as string[]
    } catch {
      continue
    }
    if (!caps.includes('llm')) continue
    try {
      const cfg = await loadProviderConfig(p)
      const models = await llm.listModels(cfg)
      reconcileProviderModels(p.id, p.type, models)
    } catch (err) {
      log.warn({ providerId: p.id, type: p.type, err }, 'Registry reconcile failed for provider')
    }
  }
}

function safeParseArray(s: string | null): string[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? (v as string[]) : []
  } catch {
    return []
  }
}
