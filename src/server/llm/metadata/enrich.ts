/**
 * SEAM enrichment — apply registry metadata onto an `LLMModel` before it reaches
 * `provider.chat()`. This is the single point that makes the model registry the
 * source of truth for the chat path (context/reasoning/maxTools/maxOutput/etc.).
 *
 * Gated by `config.modelRegistry.enabled`:
 * - OFF → pass-through (legacy behavior; providers' own metadata is used as-is).
 * - ON  → merge registry row (admin pins + reconciled auto values) onto the model.
 *         When no row exists yet (lazy, pre-reconcile), fall back to a live
 *         apiSeed > models.dev merge so the model is still enriched.
 *
 * Priority (decided at reconcile time, baked into the row): pinned admin >
 * provider-API seed > models.dev > default. Here we just apply the result.
 */

import { config } from '@/server/config'
import { getRegistryRow, rowToMetadata, apiSeedFromModel } from '@/server/services/model-registry'
import { resolveFromModelsDev, type ResolvedModelMetadata } from '@/server/llm/metadata/models-dev'
import { mergeAutoMetadata } from '@/server/llm/metadata/resolve'
import type { LLMModel } from '@/server/llm/llm/types'

/** Apply resolved metadata onto a copy of the model. */
function applyMetadata(model: LLMModel, meta: ResolvedModelMetadata): LLMModel {
  const out: LLMModel = { ...model }
  // Human-readable label (models.dev name or admin override) drives the name
  // shown everywhere a model is displayed; the raw id stays in `out.id`.
  if (meta.displayName) out.name = meta.displayName
  if (meta.contextWindow !== undefined) out.contextWindow = meta.contextWindow
  if (meta.maxOutput !== undefined) out.maxOutput = meta.maxOutput
  if (meta.supportsImageInput !== undefined) out.supportsImageInput = meta.supportsImageInput
  if (meta.supportsPdfInput !== undefined) out.supportsPdfInput = meta.supportsPdfInput
  // supportsToolCall === false → hard "no tools" (maxTools 0). true/undefined →
  // leave maxTools as-is so the provider's defaultMaxTools still applies.
  if (meta.supportsToolCall === false) out.maxTools = 0
  // thinking present (incl. efforts: []) = reasoning model; absent = no opinion
  // (leave the provider's value, which during phase 1 is still populated).
  // Provider-supplied UI notes (model quirks) survive the registry overwrite —
  // the registry stores only `{ enabled, efforts }`.
  if (meta.thinking !== undefined) {
    out.thinking = model.thinking?.note
      ? { ...meta.thinking, note: model.thinking.note }
      : meta.thinking
  }
  if (meta.pricing !== undefined) out.pricing = meta.pricing
  return out
}

/**
 * Enrich a model with registry metadata. Returns the model unchanged when the
 * registry flag is off (legacy path).
 */
export function enrichModel(providerId: string, providerType: string, model: LLMModel): LLMModel {
  if (!config.modelRegistry.enabled) return model
  if (!model?.id) return model

  // The registry must never break an actual LLM call — any failure falls back to
  // the model as the provider returned it.
  try {
    const row = getRegistryRow(providerId, model.id)
    if (row && row.enabled) {
      return applyMetadata(model, rowToMetadata(row))
    }
    // Lazy fallback before reconciliation has created a row: API seed > models.dev.
    const md = resolveFromModelsDev(providerType, model.id)?.metadata
    if (!md) return model
    return applyMetadata(model, mergeAutoMetadata(apiSeedFromModel(model), md))
  } catch {
    return model
  }
}
