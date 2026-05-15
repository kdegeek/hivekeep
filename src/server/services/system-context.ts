import { execSync } from 'child_process'
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
// language tooling. Probed once per server lifetime; result is cached.
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
]

function probeVersion(tool: string): string | null {
  try {
    const out = execSync(`${tool} --version 2>&1`, {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const firstLine = out.split('\n')[0]?.trim()
    return firstLine && firstLine.length > 0 ? firstLine : null
  } catch {
    return null
  }
}

/**
 * Get the host system context (platform, arch, available CLIs).
 * Cached after the first call — these values do not change at runtime.
 */
export function getSystemContext(): SystemContext {
  if (cached) return cached
  const runtimes: RuntimeAvailability[] = []
  for (const t of PROBED_TOOLS) {
    const version = probeVersion(t)
    if (version) runtimes.push({ name: t, version })
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
