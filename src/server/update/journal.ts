/**
 * Self-update journal — the single source of truth about the latest update
 * attempt, persisted at `<dataDir>/update/journal.json`.
 *
 * IMPORTANT: this module is imported by the boot guard (src/server/index.ts)
 * BEFORE the rest of the app loads. It must stay dependency-light: node
 * builtins and type-only imports ONLY (no config, no db, no logger — those
 * are part of the code being updated and may be broken on a failed boot).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs'
import { join, resolve } from 'path'
import type { UpdateRunInfo } from '@/shared/types'

/** Mirrors config.dataDir without importing config (which has side effects). */
export function getDataDir(): string {
  return resolve(process.env.HIVEKEEP_DATA_DIR ?? './data')
}

export function getUpdateDir(): string {
  return join(getDataDir(), 'update')
}

export function getJournalPath(): string {
  return join(getUpdateDir(), 'journal.json')
}

/** Full persisted journal: the public UpdateRunInfo plus everything the boot
 *  guard needs to perform a rollback without importing app code. */
export interface UpdateJournal extends UpdateRunInfo {
  /** Full (non-abbreviated) sha of the version we updated from */
  fromShaFull: string | null
  /** Git ref that was checked out (tag name for stable, remote sha for edge) */
  targetRef: string
  /** Repo root the update ran in */
  repoDir: string
  /** Bun executable used by the running server */
  bunPath: string
  /** Command line to respawn the server when no service manager will */
  restartCmd: string[]
  /** 'systemd-system' | 'systemd-user' | 'launchd' restart via manager; others respawn */
  installationType: string
  dbPath: string | null
  dbSnapshotPath: string | null
  distBackupPath: string | null
  /** True once the repo has been mutated (apply step started) — from this
   *  point a failure requires a rollback, not just an abort. */
  applyStarted: boolean
  /** Boot attempts since the restart was initiated (guard increments it). */
  bootAttempts: number
  rollbackError: string | null
}

export function readJournal(): UpdateJournal | null {
  try {
    const path = getJournalPath()
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf-8')) as UpdateJournal
  } catch {
    return null
  }
}

export function writeJournal(journal: UpdateJournal): void {
  const dir = getUpdateDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(getJournalPath(), JSON.stringify(journal, null, 2))
}

/** Append a line to the update log file (survives process restarts, readable
 *  by the user when everything else went wrong). Never throws. */
export function appendUpdateLog(message: string): void {
  try {
    const dir = getUpdateDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'update.log'), `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    // logging must never break the update path
  }
}

/** Strip journal internals down to the API-facing UpdateRunInfo. */
export function toRunInfo(journal: UpdateJournal): UpdateRunInfo {
  return {
    id: journal.id,
    channel: journal.channel,
    fromVersion: journal.fromVersion,
    fromSha: journal.fromSha,
    toVersion: journal.toVersion,
    status: journal.status,
    currentStep: journal.currentStep,
    error: journal.error,
    startedAt: journal.startedAt,
    finishedAt: journal.finishedAt,
  }
}
