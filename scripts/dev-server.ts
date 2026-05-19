/**
 * Dev server wrapper with selective watch.
 *
 * Why this exists: `bun --watch` tracks every file the process imports —
 * including plugins loaded via `await import(plugins/<name>/...)`. As a
 * side-effect, when the plugin install/uninstall flow creates or removes
 * files in `plugins/`, the watcher fires a reload mid-request and kills
 * the in-flight handler (manifests as a silent 500, orphan `_npm_*`
 * tempDirs, infinite UI spinners).
 *
 * This script watches `src/` only and respawns `bun src/server/index.ts`
 * on change. Plugin directories live outside the watch tree, so HTTP
 * handlers that touch `plugins/` survive to completion.
 *
 * Production path is unaffected — `bun src/server/index.ts` runs without
 * any watcher.
 */
import { watch } from 'node:fs'
import { resolve } from 'node:path'

const ENTRY = 'src/server/index.ts'
const WATCH_DIR = resolve(process.cwd(), 'src')
// Debounce so a single editor save (often multiple fs events) restarts once.
const DEBOUNCE_MS = 200

let child: ReturnType<typeof Bun.spawn> | null = null
let restartTimer: ReturnType<typeof setTimeout> | null = null
let shuttingDown = false

function startServer() {
  if (shuttingDown) return
  console.log(`[dev-server] starting ${ENTRY}`)
  child = Bun.spawn(['bun', ENTRY], {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  })
}

async function restartServer() {
  if (child) {
    try {
      child.kill()
      await child.exited
    } catch {}
    child = null
  }
  startServer()
}

function scheduleRestart(reason: string) {
  if (shuttingDown) return
  if (restartTimer) clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    console.log(`[dev-server] ${reason} — restarting`)
    void restartServer()
  }, DEBOUNCE_MS)
}

function shouldIgnore(filename: string | null): boolean {
  if (!filename) return true
  // Editor noise + non-source files.
  if (filename.endsWith('~')) return true
  if (filename.endsWith('.swp') || filename.endsWith('.swx')) return true
  if (filename.includes('/.') || filename.startsWith('.')) return true
  if (filename.endsWith('.log')) return true
  return false
}

async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[dev-server] ${signal} received, shutting down`)
  if (restartTimer) clearTimeout(restartTimer)
  if (child) {
    try {
      child.kill()
      await child.exited
    } catch {}
  }
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

// Recursive watch on src/. Linux + WSL support this since Node 20 / Bun.
watch(WATCH_DIR, { recursive: true }, (_event, filename) => {
  if (shouldIgnore(filename)) return
  scheduleRestart(`src/${filename} changed`)
})

startServer()
