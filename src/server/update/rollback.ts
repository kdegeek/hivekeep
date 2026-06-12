/**
 * Rollback executor — restores the previous version after a failed update.
 *
 * Used in two places:
 *  - the boot guard (src/server/index.ts) when the freshly-updated code fails
 *    to boot, BEFORE any app code is imported;
 *  - the orchestrator (services/self-update.ts) when a step fails after the
 *    repo was already mutated but before the restart.
 *
 * IMPORTANT: like journal.ts, this must stay dependency-light (node builtins
 * only) — when it runs from the boot guard, the app code on disk may be the
 * exact thing that is broken.
 */
import { spawnSync } from 'child_process'
import { copyFileSync, cpSync, existsSync, rmSync, unlinkSync } from 'fs'
import { join } from 'path'
import { appendUpdateLog, type UpdateJournal } from '@/server/update/journal'

export interface RollbackResult {
  ok: boolean
  error: string | null
}

function run(cmd: string[], cwd: string): { ok: boolean; output: string } {
  const proc = spawnSync(cmd[0]!, cmd.slice(1), {
    cwd,
    encoding: 'utf-8',
    timeout: 10 * 60 * 1000,
  })
  const output = `${proc.stdout ?? ''}${proc.stderr ?? ''}`.trim()
  return { ok: proc.status === 0, output }
}

/**
 * Restore the previous version recorded in the journal:
 *  1. git checkout of the previous sha
 *  2. restore the dist/client backup
 *  3. bun install (node_modules back in sync with the restored lockfile)
 *  4. restore the pre-update DB snapshot (the new version may have migrated)
 *
 * Synchronous on purpose — it runs in failure paths where the event loop may
 * not be trustworthy. Never throws.
 */
export function performRollback(journal: UpdateJournal): RollbackResult {
  const errors: string[] = []
  appendUpdateLog(`Rollback started (run ${journal.id}, back to ${journal.fromShaFull ?? 'unknown'})`)

  // 1. Repo back to the previous commit
  if (journal.fromShaFull) {
    const checkout = run(['git', 'checkout', '--force', journal.fromShaFull], journal.repoDir)
    if (checkout.ok) {
      appendUpdateLog(`Rollback: checked out ${journal.fromShaFull}`)
    } else {
      errors.push(`git checkout failed: ${checkout.output}`)
      appendUpdateLog(`Rollback: git checkout FAILED: ${checkout.output}`)
    }
  } else {
    errors.push('previous sha unknown — repo left as-is')
  }

  // 2. Frontend assets back to the backed-up build
  try {
    if (journal.distBackupPath && existsSync(journal.distBackupPath)) {
      const distClient = join(journal.repoDir, 'dist', 'client')
      rmSync(distClient, { recursive: true, force: true })
      cpSync(journal.distBackupPath, distClient, { recursive: true })
      appendUpdateLog('Rollback: dist/client restored from backup')
    }
  } catch (err) {
    errors.push(`dist restore failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 3. Dependencies back in sync with the restored lockfile
  const install = run([journal.bunPath, 'install'], journal.repoDir)
  if (install.ok) {
    appendUpdateLog('Rollback: bun install completed')
  } else {
    errors.push(`bun install failed: ${install.output}`)
    appendUpdateLog(`Rollback: bun install FAILED: ${install.output}`)
  }

  // 4. DB back to the pre-update snapshot (the new version's migrations may
  // have changed the schema in ways the old code can't read). The snapshot
  // was taken seconds before the restart, while writes were idle.
  try {
    if (journal.dbSnapshotPath && journal.dbPath && existsSync(journal.dbSnapshotPath)) {
      for (const ext of ['-shm', '-wal']) {
        const sidecar = `${journal.dbPath}${ext}`
        if (existsSync(sidecar)) unlinkSync(sidecar)
      }
      copyFileSync(journal.dbSnapshotPath, journal.dbPath)
      appendUpdateLog('Rollback: database snapshot restored')
    }
  } catch (err) {
    errors.push(`db restore failed: ${err instanceof Error ? err.message : String(err)}`)
    appendUpdateLog(`Rollback: db restore FAILED: ${err instanceof Error ? err.message : String(err)}`)
  }

  const error = errors.length > 0 ? errors.join('; ') : null
  appendUpdateLog(error ? `Rollback finished with errors: ${error}` : 'Rollback completed cleanly')
  return { ok: errors.length === 0, error }
}
