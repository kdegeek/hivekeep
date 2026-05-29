import type { KinThinkingConfig, KinThinkingEffort } from '@/shared/types'

/**
 * A single-select choice for a thinking/effort dial in a form.
 *
 * - `'inherit'` → no override; fall back to the project/Kin default (config = `null`).
 * - `'off'`     → reasoning explicitly disabled (`{ enabled: false }`).
 * - effort      → reasoning enabled at the given effort (`{ enabled: true, effort }`).
 *
 * Used by project settings and the task-start dialogs so every effort dial maps
 * to/from the on-the-wire `KinThinkingConfig | null` shape identically.
 */
export type ThinkingChoice = 'inherit' | 'off' | KinThinkingEffort

/** Map a stored thinking config (or `null` = inherit) to a form choice. */
export function configToChoice(cfg: KinThinkingConfig | null | undefined): ThinkingChoice {
  if (cfg == null) return 'inherit'
  if (!cfg.enabled) return 'off'
  return (cfg.effort ?? 'medium') as KinThinkingEffort
}

/** Map a form choice back to a thinking config (`null` = inherit/no override). */
export function choiceToConfig(choice: ThinkingChoice): KinThinkingConfig | null {
  if (choice === 'inherit') return null
  if (choice === 'off') return { enabled: false }
  return { enabled: true, effort: choice }
}
