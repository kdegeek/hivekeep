/**
 * One-time migration: before toolboxes, an Agent with null/empty `toolbox_ids`
 * meant "all tools". The resolver default has changed to "no toolbox → CORE
 * floor only", so make existing null-toolbox Agents explicit (['all']) to preserve
 * their behavior. Guarded by a setting flag so it runs exactly once — otherwise
 * it would clobber Agents a user has deliberately set to "no tools".
 */

import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { agents } from '@/server/db/schema'
import { getToolboxByName } from '@/server/services/toolboxes'
import { getSetting, setSetting } from '@/server/services/app-settings'
import { createLogger } from '@/server/logger'

const log = createLogger('migrate-agent-toolboxes')
const FLAG = 'agent_toolbox_default_migrated'

function isEmptySelection(raw: string | null): boolean {
  if (!raw) return true
  try {
    const parsed = JSON.parse(raw)
    return !Array.isArray(parsed) || parsed.length === 0
  } catch {
    return true
  }
}

export async function migrateNullAgentToolboxesToAll(): Promise<void> {
  if ((await getSetting(FLAG)) === 'true') return

  const allBox = getToolboxByName('all')
  if (!allBox) {
    // Toolboxes not seeded yet — skip without setting the flag so it retries
    // on a later boot once the built-ins exist.
    log.warn('Skipping agent-toolbox migration: "all" toolbox not seeded yet')
    return
  }

  const rows = db.select({ id: agents.id, toolboxIds: agents.toolboxIds }).from(agents).all()
  const explicitAll = JSON.stringify([allBox.id])
  let migrated = 0
  for (const r of rows) {
    if (isEmptySelection(r.toolboxIds)) {
      db.update(agents).set({ toolboxIds: explicitAll, updatedAt: new Date() }).where(eq(agents.id, r.id)).run()
      migrated++
    }
  }

  await setSetting(FLAG, 'true')
  if (migrated > 0) log.info({ migrated }, 'Migrated null-toolbox Agents to an explicit "all" selection')
}
