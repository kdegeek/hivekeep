/**
 * Fetch + trim the models.dev catalogue into a bundled snapshot.
 *
 * models.dev (MIT, https://models.dev) is a community-maintained database of LLM
 * model metadata. We use it as the seed source for Hivekeep's model registry
 * (see `model-metadata.md`). The full `api.json` is ~2.2 MB; we keep only the
 * providers' models and the fields that map onto our `LLMModel`, producing a
 * compact snapshot bundled into the server build for an offline first boot.
 *
 * Run: `bun scripts/fetch-models-dev.ts` (manually / pre-release / CI).
 * Output: `src/server/llm/metadata/models-dev-snapshot.json`.
 */

const SOURCE = 'https://models.dev/api.json'
const OUT = new URL('../src/server/llm/metadata/models-dev-snapshot.json', import.meta.url)

interface RawModel {
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

/** Trimmed per-model shape we keep in the snapshot. */
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

function trimModel(m: RawModel): SnapshotModel {
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

async function main() {
  process.stdout.write(`Fetching ${SOURCE} …\n`)
  const res = await fetch(SOURCE)
  if (!res.ok) throw new Error(`models.dev returned HTTP ${res.status}`)
  const raw = (await res.json()) as Record<string, { models?: Record<string, RawModel> }>

  const snapshot: Record<string, Record<string, SnapshotModel>> = {}
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

  // Stable key order so the bundled file diffs cleanly between refreshes.
  const sorted: Record<string, Record<string, SnapshotModel>> = {}
  for (const p of Object.keys(snapshot).sort()) {
    const ms = snapshot[p]!
    const sm: Record<string, SnapshotModel> = {}
    for (const k of Object.keys(ms).sort()) sm[k] = ms[k]!
    sorted[p] = sm
  }

  const json = JSON.stringify(sorted, null, 0)
  await Bun.write(OUT, json + '\n')
  process.stdout.write(
    `Wrote ${OUT.pathname} — ${providerCount} providers, ${modelCount} models, ${(json.length / 1024).toFixed(0)} KB\n`,
  )
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + '\n')
  process.exit(1)
})
