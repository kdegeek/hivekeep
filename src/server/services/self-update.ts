/**
 * Self-update orchestrator.
 *
 * Runs INSIDE the live server process (a detached helper would be killed with
 * the systemd cgroup when the service restarts). Sequence:
 *
 *   preflight → DB snapshot → backup (dist + sha) → download prebuilt client
 *   → apply (git fetch/checkout) → bun install → assets (extract or build)
 *   → write journal 'restarting' → restart
 *
 * Every step broadcasts `update:progress` over SSE and is persisted in the
 * journal so the UI can poll `GET /api/version-check/last-update` across the
 * restart. If anything fails after the repo was mutated, an in-process
 * rollback restores the previous version (the server never restarted, so the
 * platform stays up). If the NEW version fails to boot after the restart, the
 * boot guard in src/server/index.ts performs the rollback (see that file).
 *
 * Restart strategy by installation type:
 *  - systemd-system / systemd-user / launchd: process.exit(1) and let the
 *    service manager restart us (Restart=always / KeepAlive).
 *  - manual / script installs: respawn ourselves detached, then exit.
 */
import { spawnSync } from 'child_process'
import { Database } from 'bun:sqlite'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs'
import { join } from 'path'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import { sseManager } from '@/server/sse/index'
import {
  appendUpdateLog,
  getUpdateDir,
  readJournal,
  toRunInfo,
  writeJournal,
  type UpdateJournal,
} from '@/server/update/journal'
import { performRollback } from '@/server/update/rollback'
import { isManagedInstall, respawnDetached } from '@/server/update/respawn'
import {
  getCachedVersionInfo,
  getCurrentSha,
  getSelfUpdateCapability,
  getUpdateChannel,
} from '@/server/services/version-check'
import type { UpdateRunInfo, UpdateStepId } from '@/shared/types'

const log = createLogger('self-update')

// ─── Run state ───────────────────────────────────────────────────────────────

let activeJournal: UpdateJournal | null = null

export function isUpdateRunning(): boolean {
  return activeJournal !== null
}

/** Latest update attempt — the in-flight one, or the persisted journal. */
export function getLastUpdateRun(): UpdateRunInfo | null {
  if (activeJournal) return toRunInfo(activeJournal)
  const journal = readJournal()
  return journal ? toRunInfo(journal) : null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

class UpdateError extends Error {}

function runGit(args: string[], opts: { timeoutMs?: number } = {}): string {
  const proc = spawnSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf-8',
    timeout: opts.timeoutMs ?? 5 * 60 * 1000,
  })
  if (proc.status !== 0) {
    // status === null means the process was killed (timeout) — say so instead
    // of surfacing an empty stderr.
    const detail = (proc.stderr || proc.stdout || '').trim() || (proc.status === null ? 'timed out' : 'unknown error')
    throw new UpdateError(`git ${args[0]} failed: ${detail}`)
  }
  return (proc.stdout ?? '').trim()
}

function runBun(args: string[], opts: { timeoutMs?: number } = {}): void {
  const proc = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf-8',
    timeout: opts.timeoutMs ?? 15 * 60 * 1000,
    env: { ...process.env, HUSKY: '0' },
  })
  if (proc.status !== 0) {
    const output = `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`.trim().slice(-2000) || (proc.status === null ? 'timed out' : 'unknown error')
    throw new UpdateError(`${args.join(' ')} failed: ${output}`)
  }
}

function emitProgress(journal: UpdateJournal, step: UpdateStepId, status: 'running' | 'done' | 'error', message?: string): void {
  journal.currentStep = status === 'running' ? step : journal.currentStep
  sseManager.broadcast({
    type: 'update:progress',
    data: { runId: journal.id, step, status, message: message ?? null },
  })
  appendUpdateLog(`[${journal.id}] ${step}: ${status}${message ? ` — ${message}` : ''}`)
  if (status === 'running') {
    log.info({ step, message }, 'Update step started')
  }
}

/** Keep only the most recent N pre-update snapshots/backups. */
function pruneOldArtifacts(dir: string, prefix: string, keep: number): void {
  try {
    if (!existsSync(dir)) return
    const entries = readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort()
      .reverse()
    for (const name of entries.slice(keep)) {
      rmSync(join(dir, name), { recursive: true, force: true })
    }
  } catch {
    // best-effort cleanup
  }
}

// ─── Steps ───────────────────────────────────────────────────────────────────

function preflight(): void {
  // git available + we're in a repo
  runGit(['rev-parse', '--is-inside-work-tree'], { timeoutMs: 30_000 })

  // Refuse to update over local modifications to tracked files: a forced
  // checkout would silently destroy them. Untracked files are fine (data/,
  // node_modules/ etc. are unrelated to the working tree state).
  const status = runGit(['status', '--porcelain'], { timeoutMs: 60_000 })
  const dirty = status
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('??'))
  if (dirty.length > 0) {
    throw new UpdateError(
      `Working tree has local modifications to ${dirty.length} tracked file(s) (e.g. ${dirty[0]!.trim()}). ` +
        'Commit, stash or revert them before updating.',
    )
  }

  // Disk space sanity check (need room for deps + build + backups): require
  // ~2 GB free. Best-effort — df may not exist on exotic systems.
  try {
    const df = spawnSync('df', ['-Pk', process.cwd()], { encoding: 'utf-8' })
    if (df.status === 0) {
      const line = df.stdout.trim().split('\n').pop() ?? ''
      const availKb = Number(line.split(/\s+/)[3])
      if (Number.isFinite(availKb) && availKb < 2 * 1024 * 1024) {
        throw new UpdateError(
          `Not enough free disk space (${Math.round(availKb / 1024)} MB available, 2 GB required).`,
        )
      }
    }
  } catch (err) {
    if (err instanceof UpdateError) throw err
  }
}

function snapshotDatabase(journal: UpdateJournal): void {
  const dbPath = config.db.path
  if (!existsSync(dbPath)) return

  const snapshotDir = join(getUpdateDir(), 'db-snapshots')
  mkdirSync(snapshotDir, { recursive: true })
  const snapshotPath = join(snapshotDir, `pre-update-${journal.id}.db`)

  // VACUUM INTO is the SQLite-blessed way to take an atomic snapshot of a
  // live DB (WAL-safe, concurrent-reader-safe).
  const db = new Database(dbPath, { readonly: true })
  try {
    db.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`)
  } finally {
    db.close()
  }

  journal.dbPath = dbPath
  journal.dbSnapshotPath = snapshotPath
  pruneOldArtifacts(snapshotDir, 'pre-update-', 3)
}

function backupCurrentState(journal: UpdateJournal): void {
  journal.fromShaFull = runGit(['rev-parse', 'HEAD'], { timeoutMs: 30_000 })

  const distClient = join(process.cwd(), 'dist', 'client')
  if (existsSync(distClient)) {
    const backupDir = join(getUpdateDir(), 'dist-backups')
    mkdirSync(backupDir, { recursive: true })
    const backupPath = join(backupDir, `dist-${journal.id}`)
    cpSync(distClient, backupPath, { recursive: true })
    journal.distBackupPath = backupPath
    pruneOldArtifacts(backupDir, 'dist-', 2)
  }
}

/** Download the prebuilt client tarball attached to the release by CI.
 *  Returns the tarball path, or null when unavailable (caller falls back to a
 *  local build). Verified against the published sha256. */
async function downloadClientAssets(journal: UpdateJournal, tag: string): Promise<string | null> {
  const assetName = `hivekeep-client-${tag}.tar.gz`
  const base = `https://github.com/${config.versionCheck.repo}/releases/download/${tag}`

  try {
    const [tarRes, shaRes] = await Promise.all([
      fetch(`${base}/${assetName}`, { signal: AbortSignal.timeout(120_000) }),
      fetch(`${base}/${assetName}.sha256`, { signal: AbortSignal.timeout(30_000) }),
    ])
    if (!tarRes.ok || !shaRes.ok) {
      log.info({ tag, tarStatus: tarRes.status, shaStatus: shaRes.status }, 'Prebuilt client assets not available')
      return null
    }

    const bytes = new Uint8Array(await tarRes.arrayBuffer())
    const expected = (await shaRes.text()).trim().split(/\s+/)[0]?.toLowerCase()

    const hasher = new Bun.CryptoHasher('sha256')
    hasher.update(bytes)
    const actual = hasher.digest('hex')
    if (!expected || actual !== expected) {
      throw new UpdateError(`Prebuilt client checksum mismatch (expected ${expected}, got ${actual})`)
    }

    const downloadDir = join(getUpdateDir(), 'downloads')
    mkdirSync(downloadDir, { recursive: true })
    const tarPath = join(downloadDir, assetName)
    await Bun.write(tarPath, bytes)
    return tarPath
  } catch (err) {
    if (err instanceof UpdateError) throw err
    log.warn({ err, tag }, 'Prebuilt client download failed — will build locally')
    return null
  }
}

function extractClientAssets(tarPath: string): void {
  const stagingDir = join(getUpdateDir(), 'staging')
  rmSync(stagingDir, { recursive: true, force: true })
  mkdirSync(stagingDir, { recursive: true })

  const proc = spawnSync('tar', ['-xzf', tarPath, '-C', stagingDir], { encoding: 'utf-8' })
  if (proc.status !== 0) {
    throw new UpdateError(`tar extraction failed: ${(proc.stderr ?? '').trim()}`)
  }

  const extracted = join(stagingDir, 'dist', 'client')
  if (!existsSync(join(extracted, 'index.html'))) {
    throw new UpdateError('Prebuilt client archive is malformed (no dist/client/index.html)')
  }

  const distClient = join(process.cwd(), 'dist', 'client')
  rmSync(distClient, { recursive: true, force: true })
  mkdirSync(join(process.cwd(), 'dist'), { recursive: true })
  cpSync(extracted, distClient, { recursive: true })
  rmSync(stagingDir, { recursive: true, force: true })
  rmSync(tarPath, { force: true })
}

function restartServer(journal: UpdateJournal): void {
  if (!isManagedInstall(journal.installationType)) {
    // No service manager will bring us back: respawn ourselves detached.
    respawnDetached(journal, `[${journal.id}] Respawned detached server process`)
  }

  appendUpdateLog(`[${journal.id}] Exiting for restart into ${journal.toVersion}`)
  // Non-zero exit: works with both Restart=always and Restart=on-failure units.
  setTimeout(() => process.exit(1), 1500)
}

// ─── Orchestration ───────────────────────────────────────────────────────────

export interface StartUpdateResult {
  ok: boolean
  runId?: string
  error?: { code: string; message: string }
}

export async function startSelfUpdate(): Promise<StartUpdateResult> {
  const capability = getSelfUpdateCapability()
  if (!capability.canSelfUpdate) {
    const messages: Record<string, string> = {
      docker: 'Docker installs update by pulling a newer image, not from the UI.',
      'not-git': 'This install is not a git checkout — update it the way it was installed.',
      'dev-mode': 'Self-update is disabled outside production mode.',
    }
    return {
      ok: false,
      error: { code: 'SELF_UPDATE_UNAVAILABLE', message: messages[capability.reason ?? ''] ?? 'Self-update unavailable' },
    }
  }

  if (activeJournal) {
    return { ok: false, error: { code: 'UPDATE_IN_PROGRESS', message: 'An update is already running' } }
  }

  const info = await getCachedVersionInfo()
  if (!info.isUpdateAvailable || !info.latestVersion) {
    return { ok: false, error: { code: 'NO_UPDATE', message: 'No update available' } }
  }

  const channel = await getUpdateChannel()
  const journal: UpdateJournal = {
    id: crypto.randomUUID().slice(0, 8),
    channel,
    fromVersion: config.version,
    fromSha: getCurrentSha(),
    toVersion: info.latestVersion,
    status: 'running',
    currentStep: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    fromShaFull: null,
    targetRef: channel === 'stable' ? `v${info.latestVersion}` : `origin/${config.versionCheck.branch}`,
    repoDir: process.cwd(),
    bunPath: process.execPath,
    restartCmd: [process.execPath, ...process.argv.slice(1)],
    installationType: config.environment.installationType,
    dbPath: null,
    dbSnapshotPath: null,
    distBackupPath: null,
    applyStarted: false,
    bootAttempts: 0,
    rollbackError: null,
  }

  activeJournal = journal
  writeJournal(journal)
  log.info({ runId: journal.id, channel, from: journal.fromVersion, to: journal.toVersion }, 'Self-update started')

  // Fire and forget — progress flows over SSE, final state via the journal.
  runUpdate(journal).catch((err) => {
    log.error({ err }, 'Self-update crashed outside step handling')
  })

  return { ok: true, runId: journal.id }
}

async function runUpdate(journal: UpdateJournal): Promise<void> {
  const step = async (id: UpdateStepId, fn: () => Promise<void> | void): Promise<void> => {
    emitProgress(journal, id, 'running')
    writeJournal(journal)
    await fn()
    emitProgress(journal, id, 'done')
    writeJournal(journal)
  }

  try {
    await step('preflight', () => preflight())
    await step('snapshot', () => snapshotDatabase(journal))
    await step('backup', () => backupCurrentState(journal))

    // Download BEFORE mutating the repo so a network failure aborts cleanly.
    let tarPath: string | null = null
    if (journal.channel === 'stable') {
      await step('download', async () => {
        tarPath = await downloadClientAssets(journal, journal.targetRef)
      })
    }

    await step('apply', () => {
      journal.applyStarted = true
      writeJournal(journal)
      runGit(['fetch', '--tags', 'origin'])
      if (journal.channel === 'stable') {
        // Detached checkout of the release tag: the repo state IS the release.
        runGit(['checkout', '--force', journal.targetRef])
      } else {
        // Edge: fast-forward main. Refuse to discard local commits.
        runGit(['fetch', 'origin', config.versionCheck.branch])
        const local = runGit(['rev-parse', 'HEAD'])
        const isAncestor = spawnSync('git', ['merge-base', '--is-ancestor', local, `origin/${config.versionCheck.branch}`], { cwd: process.cwd() })
        // exit 1 = genuinely not an ancestor; anything else (null = timeout,
        // 128 = git error) is a different failure and must not be reported as
        // local divergence.
        if (isAncestor.status === 1) {
          throw new UpdateError(
            'Local HEAD has commits that are not on origin/main — refusing to overwrite them. Update manually.',
          )
        }
        if (isAncestor.status !== 0) {
          throw new UpdateError(`git merge-base failed: ${(isAncestor.stderr ?? '').toString().trim() || 'unknown error'}`)
        }
        runGit(['checkout', '--force', '-B', config.versionCheck.branch, `origin/${config.versionCheck.branch}`])
      }
    })

    await step('dependencies', () => runBun(['install']))

    await step('assets', () => {
      if (tarPath) {
        extractClientAssets(tarPath)
      } else {
        // Edge channel, or prebuilt assets unavailable: build locally.
        runBun(['run', 'build'])
      }
    })

    // Point of no return: hand off to the boot guard.
    journal.status = 'restarting'
    journal.currentStep = 'restart'
    writeJournal(journal)
    emitProgress(journal, 'restart', 'running', 'Restarting into the new version')
    log.info({ runId: journal.id }, 'Update applied — restarting')
    restartServer(journal)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err, runId: journal.id, step: journal.currentStep }, 'Self-update failed')
    appendUpdateLog(`[${journal.id}] FAILED at ${journal.currentStep}: ${message}`)

    if (journal.applyStarted) {
      // Repo already mutated — restore the previous version in place.
      // The server never restarted, so the platform stays up on the old code.
      const rollback = performRollback(journal)
      journal.rollbackError = rollback.error
    }

    journal.status = 'failed'
    journal.error = message
    journal.finishedAt = Date.now()
    writeJournal(journal)
    emitProgress(journal, journal.currentStep ?? 'preflight', 'error', message)
    sseManager.broadcast({
      type: 'update:finished',
      data: { runId: journal.id, status: 'failed', error: message },
    })
    activeJournal = null
  }
}

// ─── Boot finalization (called from main.ts once the server is healthy) ─────

/** Finalize a pending update after a successful boot: mark the journal as
 *  succeeded (or surface the rollback that the boot guard performed). */
export function finalizeUpdateOnBoot(): void {
  const journal = readJournal()
  if (!journal) return

  if (journal.status === 'restarting') {
    // We are the freshly-updated version and we booted fine.
    journal.status = 'success'
    journal.currentStep = null
    journal.finishedAt = Date.now()
    writeJournal(journal)
    appendUpdateLog(`[${journal.id}] Update to ${journal.toVersion} booted successfully`)
    log.info({ runId: journal.id, version: config.version }, 'Self-update completed successfully')
    // Clients reconnect within seconds of the restart; give them a moment.
    setTimeout(() => {
      sseManager.broadcast({
        type: 'update:finished',
        data: { runId: journal.id, status: 'success', version: config.version },
      })
    }, 3000)
  } else if (journal.status === 'rolled-back' && !journal.finishedAt) {
    // The boot guard rolled us back and we're the restored old version.
    journal.finishedAt = Date.now()
    writeJournal(journal)
    log.error(
      { runId: journal.id, error: journal.error, rollbackError: journal.rollbackError },
      'Update failed to boot — previous version was restored automatically',
    )
    setTimeout(() => {
      sseManager.broadcast({
        type: 'update:finished',
        data: { runId: journal.id, status: 'rolled-back', error: journal.error },
      })
    }, 3000)
  }
}
