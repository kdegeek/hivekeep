/**
 * Fetch + trim the models.dev catalogue (https://models.dev, MIT) into the
 * compact snapshot shape Hivekeep's model registry consumes (see
 * `model-metadata.md`). Shared by the bundling script (`fetch-models-dev.ts`,
 * writes the build-time snapshot) and the runtime refresh service
 * (`services/models-dev-snapshot.ts`, writes a data-dir override). No DB, no
 * config — just network + transform.
 */

const SOURCE = 'https://models.dev/api.json'

export interface RawModel {
  id?: string
  name?: string
  family?: string
  reasoning?: boolean
  reasoning_options?: Array<{ type?: string; values?: string[] }>
  tool_call?: boolean
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
}

/** Trimmed per-model shape kept in the snapshot. */
export interface SnapshotModel {
  name?: string
  family?: string
  context?: number
  output?: number
  /** input modalities, e.g. ["text","image","pdf"] */
  input?: string[]
  reasoning?: boolean
  /** flattened from reasoning_options[].values when an effort knob exists */
  reasoning_efforts?: string[]
  tool_call?: boolean
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
}

export type ModelsDevSnapshot = Record<string, Record<string, SnapshotModel>>

export function trimModel(m: RawModel): SnapshotModel {
  const out: SnapshotModel = {}
  if (m.name) out.name = m.name
  if (m.family) out.family = m.family
  if (typeof m.limit?.context === 'number') out.context = m.limit.context
  if (typeof m.limit?.output === 'number') out.output = m.limit.output
  if (Array.isArray(m.modalities?.input)) out.input = m.modalities.input
  if (m.reasoning) out.reasoning = true
  const efforts = (m.reasoning_options ?? [])
    .filter((o) => o.type === 'effort' && Array.isArray(o.values))
    .flatMap((o) => o.values!)
    .filter((v): v is string => typeof v === 'string')
  if (efforts.length) out.reasoning_efforts = [...new Set(efforts)]
  if (typeof m.tool_call === 'boolean') out.tool_call = m.tool_call
  if (m.cost) {
    const c: NonNullable<SnapshotModel['cost']> = {}
    if (typeof m.cost.input === 'number') c.input = m.cost.input
    if (typeof m.cost.output === 'number') c.output = m.cost.output
    if (typeof m.cost.cache_read === 'number') c.cache_read = m.cost.cache_read
    if (typeof m.cost.cache_write === 'number') c.cache_write = m.cost.cache_write
    if (Object.keys(c).length) out.cost = c
  }
  return out
}

/** Fetch the live catalogue and return the trimmed, key-sorted snapshot. */
export async function fetchModelsDevSnapshot(): Promise<{
  snapshot: ModelsDevSnapshot
  providerCount: number
  modelCount: number
}> {
  const res = await fetch(SOURCE)
  if (!res.ok) throw new Error(`models.dev returned HTTP ${res.status}`)
  const raw = (await res.json()) as Record<string, { models?: Record<string, RawModel> }>

  const snapshot: ModelsDevSnapshot = {}
  let providerCount = 0
  let modelCount = 0
  for (const [providerId, prov] of Object.entries(raw)) {
    const models = prov.models
    if (!models) continue
    const trimmed: Record<string, SnapshotModel> = {}
    for (const [modelId, m] of Object.entries(models)) {
      trimmed[modelId] = trimModel(m)
      modelCount++
    }
    if (Object.keys(trimmed).length) {
      snapshot[providerId] = trimmed
      providerCount++
    }
  }

  // Stable key order so the persisted file diffs cleanly between refreshes.
  const sorted: ModelsDevSnapshot = {}
  for (const p of Object.keys(snapshot).sort()) {
    const ms = snapshot[p]!
    const sm: Record<string, SnapshotModel> = {}
    for (const k of Object.keys(ms).sort()) sm[k] = ms[k]!
    sorted[p] = sm
  }

  return { snapshot: sorted, providerCount, modelCount }
}
