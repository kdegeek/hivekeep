/**
 * Server entry point — boot guard for the self-update system.
 *
 * The real server lives in `main.ts`. This file's only job is to make a
 * failed update unable to kill the platform: when the previous process
 * applied an update and restarted, we import the (possibly new, possibly
 * broken) app inside a try/catch. If the new code fails to even load or
 * boot, we restore the previous version (git checkout + dist backup +
 * dependencies + DB snapshot) and restart into it.
 *
 * RULES FOR THIS FILE — deliberately boring on purpose:
 *  - No app imports except src/server/update/* (which are node-builtins-only)
 *    and type-only imports. If the rest of the codebase is broken, this file
 *    must still run.
 *  - Keep it tiny. Every line here runs on every boot of every install.
 */
import {
  appendUpdateLog,
  readJournal,
  writeJournal,
  type UpdateJournal,
} from '@/server/update/journal'
import { performRollback } from '@/server/update/rollback'
import { isManagedInstall, respawnDetached } from '@/server/update/respawn'

function restartAfterRollback(journal: UpdateJournal): void {
  if (!isManagedInstall(journal.installationType)) {
    // No service manager to bring us back — respawn the (now restored) old
    // version detached before exiting.
    respawnDetached(journal, 'Respawned restored server detached')
  }
  process.exit(1)
}

function rollbackAndRestart(journal: UpdateJournal, reason: string): void {
  console.error(`[boot-guard] Update to ${journal.toVersion} failed to boot: ${reason}`)
  console.error('[boot-guard] Rolling back to the previous version...')
  appendUpdateLog(`Boot of ${journal.toVersion} failed: ${reason}`)

  const result = performRollback(journal)
  journal.status = 'rolled-back'
  journal.error = reason
  journal.rollbackError = result.error
  journal.currentStep = null
  // finishedAt stays null: the restored version's boot finalizes the journal
  // and broadcasts the outcome to clients (see finalizeUpdateOnBoot).
  writeJournal(journal)

  console.error(
    result.ok
      ? '[boot-guard] Rollback complete — restarting into the previous version.'
      : `[boot-guard] Rollback finished with errors (${result.error}) — restarting anyway.`,
  )
  restartAfterRollback(journal)
}

const journal = readJournal()

if (journal && journal.status === 'restarting') {
  // First boot(s) after an update was applied. If a previous boot attempt
  // already died without finalizing the journal, don't try again — roll back.
  journal.bootAttempts = (journal.bootAttempts ?? 0) + 1
  writeJournal(journal)

  if (journal.bootAttempts > 1) {
    rollbackAndRestart(journal, 'Previous boot attempt did not come up healthy')
  } else {
    try {
      await import('@/server/main')
      // Success is finalized by main.ts (finalizeUpdateOnBoot) once the HTTP
      // server is actually listening.
    } catch (err) {
      rollbackAndRestart(journal, err instanceof Error ? (err.stack ?? err.message) : String(err))
    }
  }
} else if (journal && journal.status === 'running') {
  // The process died mid-update (crash/power loss) before the restart step.
  appendUpdateLog(`Found interrupted update run ${journal.id} (died at step ${journal.currentStep})`)
  if (journal.applyStarted) {
    // Repo may be half-mutated — restore the previous version, then boot it.
    const result = performRollback(journal)
    journal.rollbackError = result.error
  }
  journal.status = 'failed'
  journal.error = `Update was interrupted at step '${journal.currentStep}' (process died)`
  journal.finishedAt = Date.now()
  journal.currentStep = null
  writeJournal(journal)
  await import('@/server/main')
} else {
  // Normal boot.
  await import('@/server/main')
}
