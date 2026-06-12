/**
 * Runtime refresh of the models.dev snapshot.
 *
 * The bundled snapshot (`llm/metadata/models-dev-snapshot.json`) is baked into
 * the build and not writable in production. To pick up models.dev additions
 * without a release, an admin can refresh it: we fetch the live catalogue, write
 * a trimmed copy to the (writable, persistent) data dir, and install it as the
 * active snapshot override. On startup we reload that override if present, so a
 * past refresh survives restarts. The data-dir copy always wins over the bundled
 * one once written.
 */
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { config } from '@/server/config'
import { fetchModelsDevSnapshot } from '@/server/llm/metadata/models-dev-fetch'
import { setSnapshot } from '@/server/llm/metadata/models-dev'
import { createLogger } from '@/server/logger'

const log = createLogger('models-dev-snapshot')

const SNAPSHOT_PATH = join(config.dataDir, 'models-dev-snapshot.json')

/** Load the persisted data-dir snapshot (if any) over the bundled one. Called
 *  once at startup. Safe/no-op when the file is absent or unreadable. */
export function loadPersistedSnapshot(): void {
  try {
    if (!existsSync(SNAPSHOT_PATH)) return
    const parsed = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'))
    setSnapshot(parsed)
    log.info({ path: SNAPSHOT_PATH }, 'Loaded persisted models.dev snapshot override')
  } catch (err) {
    log.warn({ err }, 'Failed to load persisted models.dev snapshot — falling back to bundled')
  }
}

/** Fetch the latest models.dev catalogue, persist it to the data dir, and make
 *  it the active snapshot. Returns the catalogue size. Throws on fetch failure. */
export async function refreshModelsDevSnapshot(): Promise<{ providerCount: number; modelCount: number }> {
  const { snapshot, providerCount, modelCount } = await fetchModelsDevSnapshot()
  await Bun.write(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 0) + '\n')
  setSnapshot(snapshot)
  log.info({ providerCount, modelCount, path: SNAPSHOT_PATH }, 'Refreshed models.dev snapshot')
  return { providerCount, modelCount }
}
