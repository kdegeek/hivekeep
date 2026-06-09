/**
 * Per-field metadata merge for the model registry.
 *
 * The registry resolves a model's metadata from several layers, highest priority
 * first (see `model-metadata.md` §7):
 *
 *   admin override (pinned field) > models.dev > provider-API seed hint > default
 *
 * `mergeMetadata` applies that priority field-by-field: for each field, the first
 * layer that defines it wins. Phase 1 wires this into the resolve.ts SEAM; this
 * module is pure (no DB/network) so it stays trivially testable.
 */

import type { ResolvedModelMetadata } from '@/server/llm/metadata/models-dev'

const FIELDS: readonly (keyof ResolvedModelMetadata)[] = [
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
