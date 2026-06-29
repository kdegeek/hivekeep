export const SERVER_STARTED_AT = Date.now()

export interface ServerRuntimeContext {
  startedAt: Date
  startedAtIso: string
  uptimeMs: number
  uptimeSeconds: number
}

/**
 * Volatile process runtime context for prompt/API consumers.
 *
 * This is intentionally process-local: it resets whenever the Hivekeep server
 * process is restarted, which lets Agents distinguish host uptime from app
 * freshness on each top-level turn.
 */
export function getServerRuntimeContext(now = Date.now()): ServerRuntimeContext {
  const uptimeMs = Math.max(0, now - SERVER_STARTED_AT)
  return {
    startedAt: new Date(SERVER_STARTED_AT),
    startedAtIso: new Date(SERVER_STARTED_AT).toISOString(),
    uptimeMs,
    uptimeSeconds: Math.floor(uptimeMs / 1000),
  }
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0 || days > 0) parts.push(`${hours}h`)
  if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}m`)
  if (parts.length === 0) parts.push(`${seconds}s`)
  return parts.join(' ')
}
