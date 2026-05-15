import { execSync } from 'child_process'
import { dirname } from 'path'
import os from 'os'
import { createLogger } from '@/server/logger'

const log = createLogger('system-context')

export interface RuntimeAvailability {
  name: string
  version: string
}

export interface SystemContext {
  platform: string
  arch: string
  runtimes: RuntimeAvailability[]
}

let cached: SystemContext | null = null

// CLIs commonly needed by sub-Kins for builds, tests, version control and
// language tooling. Probed once per server lifetime through a login shell so
// PATH additions from the user's profile (e.g. ~/.bun/bin, ~/.nvm/...) are
// picked up even when KinBot is started by systemd or another service manager
// that does not source the user profile.
const PROBED_TOOLS = [
  'bun',
  'node',
  'npm',
  'pnpm',
  'yarn',
  'git',
  'python3',
  'docker',
  'rg',
  'curl',
  'gh',
]

interface ProbeResult {
  version: string
  binDir: string
}

function probe(tool: string): ProbeResult | null {
  try {
    const out = execSync(
      `bash -lc 'p=$(command -v ${tool} 2>/dev/null) && echo "$p" && "${tool}" --version 2>&1 | head -n1'`,
      {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length < 2) return null
    const binPath = lines[0]!
    const version = lines[1]!
    if (!binPath.startsWith('/')) return null
    return { version, binDir: dirname(binPath) }
  } catch {
    return null
  }
}

/**
 * Get the host system context (platform, arch, available CLIs).
 *
 * Side effect on first call: augments `process.env.PATH` with the directories
 * of every detected tool. This way `run_shell` (which inherits process.env)
 * gets the same PATH as the probe, so the sub-Kin can call any tool listed in
 * the Environment block without doing its own PATH archaeology.
 *
 * Cached after the first call — these values do not change at runtime.
 */
export function getSystemContext(): SystemContext {
  if (cached) return cached
  const runtimes: RuntimeAvailability[] = []
  const augmentDirs = new Set<string>()
  for (const t of PROBED_TOOLS) {
    const result = probe(t)
    if (!result) continue
    runtimes.push({ name: t, version: result.version })
    augmentDirs.add(result.binDir)
  }

  if (augmentDirs.size > 0) {
    const existing = (process.env.PATH ?? '').split(':').filter(Boolean)
    const existingSet = new Set(existing)
    const additions: string[] = []
    for (const dir of augmentDirs) {
      if (!existingSet.has(dir)) additions.push(dir)
    }
    if (additions.length > 0) {
      process.env.PATH = [...additions, ...existing].join(':')
      log.info({ added: additions }, 'PATH augmented with detected tool dirs')
    }
  }

  cached = {
    platform: os.platform(),
    arch: os.arch(),
    runtimes,
  }
  log.info(
    { platform: cached.platform, arch: cached.arch, runtimes: runtimes.map((r) => r.name) },
    'System context probed',
  )
  return cached
}

/** Reset the cache. Test-only. */
export function _resetSystemContextCache(): void {
  cached = null
}
