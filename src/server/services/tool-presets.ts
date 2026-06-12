/**
 * CORE_TOOLS re-export.
 *
 * Historically this module held the sub-Agent tool *presets* (`applyPreset`,
 * `defaultPresetForTask`, `listPresetTools`). Those were superseded by the
 * global toolboxes system (services/toolboxes.ts) and the unified resolver
 * (services/toolset-resolver.ts), and have been removed.
 *
 * `CORE_TOOLS` — the mandatory floor present in every resolved toolset
 * regardless of toolbox selection (file ops, shell, the sub-Agent reply
 * protocol, human-prompt, notify) — now lives in `@/shared/constants` (the
 * single source of truth, shared with the client Agent tools preview). It is
 * re-exported here so the existing server imports of `CORE_TOOLS` from this
 * module keep working unchanged.
 */
import { CORE_TOOLS } from '@/shared/constants'
export { CORE_TOOLS }
