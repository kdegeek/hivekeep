import { rm } from 'fs/promises'

/**
 * Playwright global setup — runs once before all tests.
 * Deletes the E2E database so every test run starts fresh.
 */
export default async function globalSetup() {
  const dbPath = process.env.E2E_DB_PATH || './data/hivekeep-e2e.db'
  await Promise.all([
    rm(dbPath, { force: true }),
    rm(`${dbPath}-wal`, { force: true }),
    rm(`${dbPath}-shm`, { force: true }),
  ])
}
