import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The journal resolves its directory from HIVEKEEP_DATA_DIR at call time, so
// pointing it at a temp dir gives us full isolation without mocks.
import {
  getJournalPath,
  readJournal,
  writeJournal,
  appendUpdateLog,
  toRunInfo,
  type UpdateJournal,
} from '@/server/update/journal'

let tempDir: string
let previousDataDir: string | undefined

function sampleJournal(overrides: Partial<UpdateJournal> = {}): UpdateJournal {
  return {
    id: 'run-test',
    channel: 'stable',
    fromVersion: '1.0.0',
    fromSha: 'abc1234',
    toVersion: '1.1.0',
    status: 'running',
    currentStep: 'preflight',
    error: null,
    startedAt: 1000,
    finishedAt: null,
    fromShaFull: 'abc1234def5678',
    targetRef: 'v1.1.0',
    repoDir: '/srv/hivekeep',
    bunPath: '/usr/local/bin/bun',
    restartCmd: ['/usr/local/bin/bun', 'src/server/index.ts'],
    installationType: 'systemd-system',
    dbPath: null,
    dbSnapshotPath: null,
    distBackupPath: null,
    applyStarted: false,
    bootAttempts: 0,
    rollbackError: null,
    ...overrides,
  }
}

beforeEach(() => {
  previousDataDir = process.env.HIVEKEEP_DATA_DIR
  tempDir = mkdtempSync(join(tmpdir(), 'hivekeep-journal-test-'))
  process.env.HIVEKEEP_DATA_DIR = tempDir
})

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.HIVEKEEP_DATA_DIR
  else process.env.HIVEKEEP_DATA_DIR = previousDataDir
  rmSync(tempDir, { recursive: true, force: true })
})

describe('update journal', () => {
  it('returns null when no journal exists', () => {
    expect(readJournal()).toBeNull()
  })

  it('round-trips a journal through write/read', () => {
    const journal = sampleJournal()
    writeJournal(journal)
    expect(existsSync(getJournalPath())).toBe(true)
    const read = readJournal()
    expect(read).toEqual(journal)
  })

  it('overwrites the previous journal on write', () => {
    writeJournal(sampleJournal({ id: 'first' }))
    writeJournal(sampleJournal({ id: 'second', status: 'restarting' }))
    const read = readJournal()
    expect(read?.id).toBe('second')
    expect(read?.status).toBe('restarting')
  })

  it('returns null for a corrupted journal file instead of throwing', () => {
    writeJournal(sampleJournal())
    const path = getJournalPath()
    Bun.spawnSync(['bash', '-c', `echo 'not json' > '${path}'`])
    expect(readJournal()).toBeNull()
  })

  it('strips internals down to the public run info', () => {
    const journal = sampleJournal({ status: 'success', finishedAt: 2000 })
    const info = toRunInfo(journal)
    expect(info).toEqual({
      id: 'run-test',
      channel: 'stable',
      fromVersion: '1.0.0',
      fromSha: 'abc1234',
      toVersion: '1.1.0',
      status: 'success',
      currentStep: 'preflight',
      error: null,
      startedAt: 1000,
      finishedAt: 2000,
    })
    expect('bunPath' in info).toBe(false)
    expect('dbSnapshotPath' in info).toBe(false)
  })

  it('appends to the update log without throwing', () => {
    appendUpdateLog('first line')
    appendUpdateLog('second line')
    const content = readFileSync(join(tempDir, 'update', 'update.log'), 'utf-8')
    expect(content).toContain('first line')
    expect(content).toContain('second line')
    expect(content.trim().split('\n')).toHaveLength(2)
  })
})
