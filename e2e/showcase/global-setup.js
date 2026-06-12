import { rm } from 'fs/promises'

/**
 * Showcase global setup — runs once before the showcase test.
 * Deletes the database so the showcase starts from a fresh onboarding.
 */
export default async function globalSetup() {
  const dbPath = process.env.E2E_DB_PATH || './data/hivekeep-showcase.db'
  await Promise.all([
    rm(dbPath, { force: true }),
    rm(`${dbPath}-wal`, { force: true }),
    rm(`${dbPath}-shm`, { force: true }),
  ])
}
