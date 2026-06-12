/**
 * SQLite snapshot helper. Three subcommands:
 *
 *   bun scripts/db-snapshot.ts create [label]
 *   bun scripts/db-snapshot.ts list
 *   bun scripts/db-snapshot.ts restore <name>
 *
 * Snapshots live under `data/snapshots/<timestamp>[__label]/hivekeep.db`.
 * Created with `VACUUM INTO` so the file is atomic and safe to copy
 * while the dev server is running. Restore stops at a confirmation
 * prompt because it overwrites the live DB.
 *
 * Intended for the onboarding flow loop: snapshot the real DB, point
 * the server at a fresh one (`rm data/hivekeep.db && bun run db:migrate`),
 * exercise the wizard, then restore.
 */
import { Database } from 'bun:sqlite'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'fs'
import { dirname, join, resolve } from 'path'

const dbPath = resolve(process.env.DB_PATH ?? './data/hivekeep.db')
const dataDir = dirname(dbPath)
const snapshotsDir = join(dataDir, 'snapshots')

const [, , subcommand = 'list', arg] = process.argv

function ensureSnapshotsDir() {
  if (!existsSync(snapshotsDir)) mkdirSync(snapshotsDir, { recursive: true })
}

function timestamp(): string {
  // 2026-05-22_14-37-09
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return [
    now.getFullYear(),
    '-',
    pad(now.getMonth() + 1),
    '-',
    pad(now.getDate()),
    '_',
    pad(now.getHours()),
    '-',
    pad(now.getMinutes()),
    '-',
    pad(now.getSeconds()),
  ].join('')
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function create(label?: string) {
  if (!existsSync(dbPath)) {
    console.error(`No DB at ${dbPath}. Run "bun run db:migrate" first.`)
    process.exit(1)
  }
  ensureSnapshotsDir()

  const slug = label
    ? label.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '')
    : ''
  const folderName = slug ? `${timestamp()}__${slug}` : timestamp()
  const folderPath = join(snapshotsDir, folderName)
  mkdirSync(folderPath, { recursive: true })

  const targetPath = join(folderPath, 'hivekeep.db')
  const targetForSql = targetPath.replace(/'/g, "''")

  // VACUUM INTO is the SQLite-blessed way to take an atomic snapshot
  // of a live DB. Works even with WAL mode and concurrent readers.
  const db = new Database(dbPath, { readonly: true })
  try {
    db.exec(`VACUUM INTO '${targetForSql}'`)
  } finally {
    db.close()
  }

  const size = statSync(targetPath).size
  console.log(`✓ Snapshot created: ${folderName} (${humanSize(size)})`)
  console.log(`  ${targetPath}`)
}

function list() {
  if (!existsSync(snapshotsDir)) {
    console.log('No snapshots yet.')
    return
  }
  const entries = readdirSync(snapshotsDir)
    .filter((name) => {
      const p = join(snapshotsDir, name, 'hivekeep.db')
      return existsSync(p) && statSync(p).isFile()
    })
    .sort()
    .reverse()

  if (entries.length === 0) {
    console.log('No snapshots yet.')
    return
  }

  console.log(`Snapshots in ${snapshotsDir}:`)
  for (const name of entries) {
    const p = join(snapshotsDir, name, 'hivekeep.db')
    const size = statSync(p).size
    console.log(`  ${name}  (${humanSize(size)})`)
  }
}

function restore(name: string) {
  if (!name) {
    console.error('Usage: bun scripts/db-snapshot.ts restore <snapshot-name> [--yes]')
    console.error('Run "bun scripts/db-snapshot.ts list" to see available snapshots.')
    process.exit(1)
  }
  const sourcePath = join(snapshotsDir, name, 'hivekeep.db')
  if (!existsSync(sourcePath)) {
    console.error(`Snapshot not found: ${sourcePath}`)
    process.exit(1)
  }
  if (!process.argv.includes('--yes')) {
    console.error(`This will overwrite ${dbPath} with ${sourcePath}.`)
    console.error('Stop the dev server first, then re-run with --yes to confirm.')
    process.exit(1)
  }

  // Remove WAL/SHM so SQLite doesn't replay them on top of the
  // restored file (they would re-introduce post-snapshot writes).
  for (const ext of ['-shm', '-wal']) {
    const sidecar = `${dbPath}${ext}`
    if (existsSync(sidecar)) unlinkSync(sidecar)
  }
  copyFileSync(sourcePath, dbPath)
  console.log(`✓ Restored ${name} → ${dbPath}`)
}

switch (subcommand) {
  case 'create':
    create(arg)
    break
  case 'list':
    list()
    break
  case 'restore':
    restore(arg ?? '')
    break
  default:
    console.error(`Unknown subcommand: ${subcommand}`)
    console.error('Usage:')
    console.error('  bun scripts/db-snapshot.ts create [label]')
    console.error('  bun scripts/db-snapshot.ts list')
    console.error('  bun scripts/db-snapshot.ts restore <snapshot-name>')
    process.exit(1)
}
