import { THINKING_EFFORTS, DEFAULT_THINKING_EFFORTS } from '@/shared/constants'
import type { AgentThinkingEffort } from '@/shared/types'

/**
 * What an effort selector should offer for a given model — derived from the
 * registry-enriched `thinking` field served by GET /api/providers/models.
 *
 * - `unknown`     → no model selected / model not in the catalogue (plugin
 *                   provider, stale id). Offer the classic default ladder; the
 *                   provider clamps at request time anyway.
 * - `levels`      → reasoning with an explicit effort list. Offer exactly it.
 * - `toggle`      → reasoning supported but no granularity (on/off only).
 * - `unsupported` → known model with no reasoning support. Off only.
 */
export interface ModelReasoningInfo {
  kind: 'unknown' | 'unsupported' | 'toggle' | 'levels'
  /** Effort levels to offer (empty for toggle/unsupported). */
  efforts: readonly AgentThinkingEffort[]
  /** Provider-supplied UI note about quirks, when any. */
  note?: string
}

/** Minimal shape consumed — matches `ProviderModel.thinking`. */
export interface ModelWithThinking {
  thinking?: { efforts: AgentThinkingEffort[]; note?: string }
}

export function modelReasoningInfo(model: ModelWithThinking | null | undefined): ModelReasoningInfo {
  if (!model) return { kind: 'unknown', efforts: DEFAULT_THINKING_EFFORTS }
  const thinking = model.thinking
  if (!thinking) return { kind: 'unsupported', efforts: [] }
  if (thinking.efforts.length === 0) {
    return { kind: 'toggle', efforts: [], ...(thinking.note ? { note: thinking.note } : {}) }
  }
  // Present in canonical order regardless of upstream ordering.
  const efforts = THINKING_EFFORTS.filter((e) => thinking.efforts.includes(e))
  return { kind: 'levels', efforts, ...(thinking.note ? { note: thinking.note } : {}) }
}

/**
 * Clamp an effort to the closest level the model supports — the client mirror
 * of the providers' `downgradeEffort` (scan downward from the request, else
 * the model's floor). Returns the value unchanged for unknown models and null
 * when the model has no levels to clamp onto.
 */
export function clampEffort(
  effort: AgentThinkingEffort,
  info: ModelReasoningInfo,
): AgentThinkingEffort | null {
  if (info.kind === 'unknown') return effort
  if (info.efforts.length === 0) return null
  if (info.efforts.includes(effort)) return effort
  const idx = THINKING_EFFORTS.indexOf(effort)
  for (let i = idx; i >= 0; i--) {
    const level = THINKING_EFFORTS[i]!
    if (info.efforts.includes(level)) return level
  }
  return info.efforts[0] ?? null
}
