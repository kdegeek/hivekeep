/**
 * Detached server respawn — used when no service manager (systemd/launchd)
 * will restart the process after a self-update or rollback exit.
 *
 * Dependency-light zone (node builtins only): the boot guard imports this.
 */
import { spawn } from 'child_process'
import { appendUpdateLog, type UpdateJournal } from '@/server/update/journal'

const MANAGED_INSTALL_TYPES = ['systemd-system', 'systemd-user', 'launchd']

/** True when a service manager will restart the server after process exit. */
export function isManagedInstall(installationType: string): boolean {
  return MANAGED_INSTALL_TYPES.includes(installationType)
}

/** Respawn the server detached (manual/script installs only). The short sleep
 *  lets the dying process release the port first. */
export function respawnDetached(journal: UpdateJournal, label: string): void {
  const cmd = journal.restartCmd
  const shellCmd = `sleep 2; exec ${cmd.map((c) => `'${c.replace(/'/g, "'\\''")}'`).join(' ')}`
  const child = spawn('bash', ['-c', shellCmd], {
    cwd: journal.repoDir,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
  appendUpdateLog(`${label} (pid ${child.pid})`)
}
