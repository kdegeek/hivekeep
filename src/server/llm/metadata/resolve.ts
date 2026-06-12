/**
 * Per-field metadata merge for the model registry.
 *
 * The registry resolves a model's metadata from several layers, highest priority
 * first (see `model-metadata.md` §7):
 *
 *   admin override (pinned field) > provider-API seed > models.dev > default
 *
 * Exception (see `mergeAutoMetadata`): a models.dev entry with an explicit,
 * non-empty reasoning-effort list beats the seed for the `thinking` field.
 *
 * `mergeMetadata` applies that priority field-by-field: for each field, the first
 * layer that defines it wins. Phase 1 wires this into the resolve.ts SEAM; this
 * module is pure (no DB/network) so it stays trivially testable.
 */

import type { ResolvedModelMetadata } from '@/server/llm/metadata/models-dev'

const FIELDS: readonly (keyof ResolvedModelMetadata)[] = [
  'displayName',
  'contextWindow',
  'maxOutput',
  'supportsImageInput',
  'supportsPdfInput',
  'supportsToolCall',
  'thinking',
  'pricing',
]

/**
 * Merge metadata layers by priority (highest first). For each field, the first
 * layer with a defined value wins; `undefined` means "this layer has no opinion".
 */
export function mergeMetadata(
  ...layers: Array<ResolvedModelMetadata | null | undefined>
): ResolvedModelMetadata {
  const out: ResolvedModelMetadata = {}
  for (const field of FIELDS) {
    for (const layer of layers) {
      if (layer && layer[field] !== undefined) {
        // Safe: same key copied to the same field type.
        ;(out as Record<string, unknown>)[field] = layer[field]
        break
      }
    }
  }
  return out
}

/**
 * Merge the two AUTO layers (provider-API seed > models.dev) with one
 * field-level exception: when models.dev carries an explicit, non-empty effort
 * list for `thinking`, it wins over the seed. Provider seeds are either
 * name-pattern heuristics (OpenAI/xAI hardcode `['low','medium','high']`) or a
 * coarser capability read — models.dev's curated per-model list is strictly
 * more accurate there (e.g. gpt-5.2 supports minimal→xhigh). The inverse stays
 * protected: a models.dev entry with NO effort granularity (`efforts: []`,
 * i.e. toggle- or budget-only) never clobbers a seed that advertises efforts
 * (e.g. Anthropic's capabilities API), because the seed wins the generic merge.
 */
export function mergeAutoMetadata(
  apiSeed: ResolvedModelMetadata | null | undefined,
  modelsDev: ResolvedModelMetadata | null | undefined,
): ResolvedModelMetadata {
  const out = mergeMetadata(apiSeed, modelsDev)
  if (modelsDev?.thinking?.efforts?.length) out.thinking = modelsDev.thinking
  return out
}
