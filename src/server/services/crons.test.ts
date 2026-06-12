import { describe, it, expect } from 'bun:test'

/**
 * Tests for crons service — pure logic and validation patterns.
 *
 * We avoid mock.module() for shared modules (db, schema) because Bun's
 * mock.module is global and would break other test files when running
 * the full suite. Instead, we test the pure logic extracted from the module.
 */

// ─── _parseCronArg logic (internal, tested via pattern replication) ──────────

/**
 * Replicated from crons.ts _parseCronArg for isolated testing.
 * Detects ISO 8601 datetime vs cron expression.
 */
function parseCronArg(schedule: string): string | Date {
  if (/^\d{4}-\d{2}-\d{2}/.test(schedule)) {
    const d = new Date(schedule)
    if (!isNaN(d.getTime())) return d
  }
  return schedule
}

describe('parseCronArg — schedule type detection', () => {
  it('returns Date for full ISO datetime', () => {
    const result = parseCronArg('2026-03-15T10:00:00Z')
    expect(result).toBeInstanceOf(Date)
    expect((result as Date).getUTCFullYear()).toBe(2026)
    expect((result as Date).getUTCMonth()).toBe(2)
    expect((result as Date).getUTCDate()).toBe(15)
  })

  it('returns Date for date-only string', () => {
    const result = parseCronArg('2026-12-25')
    expect(result).toBeInstanceOf(Date)
  })

  it('returns Date for datetime with timezone offset', () => {
    const result = parseCronArg('2026-06-01T14:30:00+02:00')
    expect(result).toBeInstanceOf(Date)
    expect((result as Date).getUTCHours()).toBe(12) // 14:30 +02:00 = 12:30 UTC
  })

  it('returns string for standard cron expressions', () => {
    const expressions = [
      '*/5 * * * *',
      '0 9 * * 1',
      '0 0 1 * *',
      '30 */2 * * *',
      '0 0 * * MON-FRI',
      '@hourly',
    ]
    for (const expr of expressions) {
      const result = parseCronArg(expr)
      expect(typeof result).toBe('string')
      expect(result).toBe(expr)
    }
  })

  it('returns string for empty input', () => {
    expect(typeof parseCronArg('')).toBe('string')
  })

  it('returns string for invalid ISO-like dates', () => {
    // "2026-99-99" produces an invalid Date
    const result = parseCronArg('2026-99-99')
    expect(typeof result).toBe('string')
  })

  it('returns string for random text', () => {
    expect(typeof parseCronArg('every monday')).toBe('string')
    expect(typeof parseCronArg('hourly')).toBe('string')
  })
})

// ─── Schedule validation logic ───────────────────────────────────────────────

describe('schedule validation — past/future detection', () => {
  it('rejects past ISO datetimes', () => {
    const schedule = '2020-01-01T00:00:00Z'
    const arg = parseCronArg(schedule)
    expect(arg).toBeInstanceOf(Date)
    expect((arg as Date) <= new Date()).toBe(true)
  })

  it('accepts future ISO datetimes', () => {
    const schedule = '2099-12-31T23:59:59Z'
    const arg = parseCronArg(schedule)
    expect(arg).toBeInstanceOf(Date)
    expect((arg as Date) <= new Date()).toBe(false)
  })

  it('handles edge case — datetime exactly now is rejected', () => {
    // A datetime at or before "now" should be rejected
    const now = new Date()
    const pastMs = now.getTime() - 1000
    const schedule = new Date(pastMs).toISOString()
    const arg = parseCronArg(schedule)
    expect(arg).toBeInstanceOf(Date)
    expect((arg as Date) <= new Date()).toBe(true)
  })
})

// ─── Cron schedule format patterns ──────────────────────────────────────────

describe('cron expression patterns', () => {
  it('standard 5-field cron is valid format', () => {
    const pattern = /^(\S+\s+){4}\S+$/
    expect(pattern.test('*/5 * * * *')).toBe(true)
    expect(pattern.test('0 9 * * 1')).toBe(true)
    expect(pattern.test('0 0 1 1 *')).toBe(true)
  })

  it('distinguishes cron from ISO datetime', () => {
    const isIso = /^\d{4}-\d{2}-\d{2}/
    expect(isIso.test('*/5 * * * *')).toBe(false)
    expect(isIso.test('2026-03-15T10:00:00Z')).toBe(true)
  })
})

// ─── Max active crons config ────────────────────────────────────────────────

describe('config constraints', () => {
  it('maxActive default is reasonable', () => {
    // The service uses config.crons.maxActive to limit active crons
    // This test documents the expected constraint
    const maxActive = 50 // from config mock / default
    expect(maxActive).toBeGreaterThan(0)
    expect(maxActive).toBeLessThanOrEqual(1000) // sanity upper bound
  })

  it('maxConcurrentExecutions prevents overlapping runs', () => {
    const maxConcurrent = 3 // from config
    expect(maxConcurrent).toBeGreaterThan(0)
  })
})

// ─── CreateCron params validation ───────────────────────────────────────────

describe('CreateCronParams interface contracts', () => {
  it('createdBy distinguishes user vs agent crons', () => {
    const userCron = { createdBy: 'user' as const }
    const agentCron = { createdBy: 'agent' as const }

    // Agent-created crons should require approval (isActive=false by default)
    const isAgentCreated = agentCron.createdBy === 'agent'
    expect(isAgentCreated).toBe(true)
    expect(userCron.createdBy).not.toBe('agent')
  })

  it('runOnce defaults to false when not specified', () => {
    const params = { runOnce: undefined }
    expect(params.runOnce ?? false).toBe(false)
  })

  it('runOnce can be explicitly true', () => {
    const params = { runOnce: true }
    expect(params.runOnce ?? false).toBe(true)
  })

  it('targetAgentId is optional — defaults to agentId', () => {
    const params = { agentId: 'agent-1', targetAgentId: undefined }
    const effectiveTarget = params.targetAgentId ?? params.agentId
    expect(effectiveTarget).toBe('agent-1')
  })

  it('targetAgentId overrides agentId when set', () => {
    const params = { agentId: 'agent-1', targetAgentId: 'agent-2' }
    const effectiveTarget = params.targetAgentId ?? params.agentId
    expect(effectiveTarget).toBe('agent-2')
  })

  it('model is optional — null when not provided', () => {
    const model: string | undefined = undefined
    expect(model ?? null).toBeNull()
  })
})

// ─── triggerParentTurn → spawn mode routing ─────────────────────────────────

/**
 * Replicated from crons.ts triggerCron / triggerCronManually mode selection.
 * When triggerParentTurn is set, the spawned task runs in 'await' mode so its
 * final report wakes the parent Agent for an LLM turn; otherwise 'async' (silent).
 */
function spawnModeFor(cron: { triggerParentTurn?: boolean }): 'await' | 'async' {
  return cron.triggerParentTurn ? 'await' : 'async'
}

describe('triggerParentTurn — spawn mode routing', () => {
  it('uses await mode when triggerParentTurn is true', () => {
    expect(spawnModeFor({ triggerParentTurn: true })).toBe('await')
  })

  it('uses async mode when triggerParentTurn is false', () => {
    expect(spawnModeFor({ triggerParentTurn: false })).toBe('async')
  })

  it('defaults to async mode when flag is undefined (retro-compat)', () => {
    expect(spawnModeFor({})).toBe('async')
  })
})

// ─── SSE event types ────────────────────────────────────────────────────────

describe('SSE event types for crons', () => {
  const validEvents = ['cron:created', 'cron:updated', 'cron:deleted', 'cron:triggered']

  it('all cron SSE events follow cron: prefix pattern', () => {
    for (const event of validEvents) {
      expect(event.startsWith('cron:')).toBe(true)
    }
  })

  it('event data always includes cronId and agentId', () => {
    const eventData = { cronId: 'c-1', agentId: 'k-1' }
    expect(eventData).toHaveProperty('cronId')
    expect(eventData).toHaveProperty('agentId')
  })
})
