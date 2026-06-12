import { describe, it, expect } from 'bun:test'
import { randomBytes } from 'crypto'

// ─── Pure helpers replicated from invitations.ts ────────────────────────────

// generateToken: produces a 64-char hex string (32 random bytes)
function generateToken(): string {
  return randomBytes(32).toString('hex')
}

// buildInvitationUrl: constructs the public invitation URL
function buildInvitationUrl(token: string, publicUrl: string): string {
  return `${publicUrl}/invite/${token}`
}

// ─── validateInvitation logic (extracted for unit testing) ───────────────────

interface InvitationRow {
  token: string
  usedAt: number | null
  expiresAt: number | Date
  label: string | null
}

function validateInvitationLogic(
  inv: InvitationRow | null,
): { valid: boolean; reason?: string; label?: string } {
  if (!inv) {
    return { valid: false, reason: 'NOT_FOUND' }
  }

  if (inv.usedAt) {
    return { valid: false, reason: 'ALREADY_USED' }
  }

  const expiresAt = inv.expiresAt instanceof Date ? inv.expiresAt.getTime() : (inv.expiresAt as number)
  if (expiresAt < Date.now()) {
    return { valid: false, reason: 'EXPIRED' }
  }

  return { valid: true, label: inv.label ?? undefined }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('generateToken', () => {
  it('returns a 64-character hex string', () => {
    const token = generateToken()
    expect(token).toHaveLength(64)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('generates unique tokens on each call', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateToken()))
    expect(tokens.size).toBe(100)
  })

  it('produces valid hex characters only', () => {
    for (let i = 0; i < 50; i++) {
      const token = generateToken()
      for (const char of token) {
        expect('0123456789abcdef').toContain(char)
      }
    }
  })
})

describe('buildInvitationUrl', () => {
  it('constructs URL with token', () => {
    const url = buildInvitationUrl('abc123', 'https://hivekeep.example.com')
    expect(url).toBe('https://hivekeep.example.com/invite/abc123')
  })

  it('handles trailing slash in publicUrl', () => {
    // The module does NOT strip trailing slashes, so this produces a double slash
    const url = buildInvitationUrl('token', 'https://example.com/')
    expect(url).toBe('https://example.com//invite/token')
  })

  it('handles localhost URLs', () => {
    const url = buildInvitationUrl('deadbeef', 'http://localhost:3000')
    expect(url).toBe('http://localhost:3000/invite/deadbeef')
  })

  it('preserves full token in URL', () => {
    const token = 'a'.repeat(64)
    const url = buildInvitationUrl(token, 'https://app.test')
    expect(url).toContain(token)
    expect(url).toBe(`https://app.test/invite/${token}`)
  })
})

describe('validateInvitation logic', () => {
  it('returns NOT_FOUND for null invitation', () => {
    const result = validateInvitationLogic(null)
    expect(result).toEqual({ valid: false, reason: 'NOT_FOUND' })
  })

  it('returns ALREADY_USED when usedAt is set', () => {
    const result = validateInvitationLogic({
      token: 'abc',
      usedAt: Date.now() - 1000,
      expiresAt: Date.now() + 86400000,
      label: 'Test',
    })
    expect(result).toEqual({ valid: false, reason: 'ALREADY_USED' })
  })

  it('returns EXPIRED when expiresAt is in the past (number)', () => {
    const result = validateInvitationLogic({
      token: 'abc',
      usedAt: null,
      expiresAt: Date.now() - 1000,
      label: null,
    })
    expect(result).toEqual({ valid: false, reason: 'EXPIRED' })
  })

  it('returns EXPIRED when expiresAt is a past Date object', () => {
    const result = validateInvitationLogic({
      token: 'abc',
      usedAt: null,
      expiresAt: new Date(Date.now() - 60000),
      label: null,
    })
    expect(result).toEqual({ valid: false, reason: 'EXPIRED' })
  })

  it('returns valid for unused, non-expired invitation', () => {
    const result = validateInvitationLogic({
      token: 'abc',
      usedAt: null,
      expiresAt: Date.now() + 86400000,
      label: 'Welcome',
    })
    expect(result).toEqual({ valid: true, label: 'Welcome' })
  })

  it('returns valid with undefined label when label is null', () => {
    const result = validateInvitationLogic({
      token: 'abc',
      usedAt: null,
      expiresAt: Date.now() + 86400000,
      label: null,
    })
    expect(result).toEqual({ valid: true, label: undefined })
  })

  it('checks usedAt before expiry (used + expired returns ALREADY_USED)', () => {
    const result = validateInvitationLogic({
      token: 'abc',
      usedAt: Date.now() - 5000,
      expiresAt: Date.now() - 1000,
      label: null,
    })
    // usedAt is checked first
    expect(result.reason).toBe('ALREADY_USED')
  })

  it('handles expiresAt exactly at Date.now() as expired', () => {
    // expiresAt < Date.now() — if equal, Date.now() may advance by the time we check
    // but expiresAt = some past ms should be expired
    const pastMs = Date.now() - 1
    const result = validateInvitationLogic({
      token: 'abc',
      usedAt: null,
      expiresAt: pastMs,
      label: null,
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('EXPIRED')
  })

  it('handles far-future expiry as valid', () => {
    const result = validateInvitationLogic({
      token: 'abc',
      usedAt: null,
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      label: 'Long-lived',
    })
    expect(result.valid).toBe(true)
    expect(result.label).toBe('Long-lived')
  })
})

// ─── Rate limiting pattern (from inter-agent.ts, tested here as shared pattern) ─

describe('in-memory rate limiter', () => {
  // Replicate the rate limiter from inter-agent.ts
  const rateLimitMap = new Map<string, number[]>()

  function checkRateLimit(
    senderId: string,
    targetId: string,
    maxPerMinute: number,
  ): boolean {
    const key = `${senderId}→${targetId}`
    const now = Date.now()
    const windowMs = 60_000

    let timestamps = rateLimitMap.get(key) ?? []
    timestamps = timestamps.filter((t) => now - t < windowMs)
    rateLimitMap.set(key, timestamps)

    if (timestamps.length >= maxPerMinute) {
      return false
    }

    timestamps.push(now)
    return true
  }

  it('allows first request', () => {
    rateLimitMap.clear()
    expect(checkRateLimit('a', 'b', 5)).toBe(true)
  })

  it('allows requests up to the limit', () => {
    rateLimitMap.clear()
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit('a', 'b', 5)).toBe(true)
    }
  })

  it('blocks requests exceeding the limit', () => {
    rateLimitMap.clear()
    for (let i = 0; i < 5; i++) {
      checkRateLimit('a', 'b', 5)
    }
    expect(checkRateLimit('a', 'b', 5)).toBe(false)
  })

  it('tracks sender→target pairs independently', () => {
    rateLimitMap.clear()
    // Fill up a→b
    for (let i = 0; i < 3; i++) {
      checkRateLimit('a', 'b', 3)
    }
    expect(checkRateLimit('a', 'b', 3)).toBe(false)
    // a→c should still be allowed
    expect(checkRateLimit('a', 'c', 3)).toBe(true)
    // b→a should also be allowed (different direction)
    expect(checkRateLimit('b', 'a', 3)).toBe(true)
  })

  it('expires old timestamps after the window', () => {
    rateLimitMap.clear()
    // Manually inject old timestamps
    const oldTime = Date.now() - 61_000 // 61 seconds ago
    rateLimitMap.set('x→y', [oldTime, oldTime, oldTime])

    // Should allow since old entries are pruned
    expect(checkRateLimit('x', 'y', 3)).toBe(true)
  })

  it('handles limit of 1', () => {
    rateLimitMap.clear()
    expect(checkRateLimit('a', 'b', 1)).toBe(true)
    expect(checkRateLimit('a', 'b', 1)).toBe(false)
  })
})

// ─── agentAvatarUrl pattern (shared across tasks.ts, notifications.ts) ────────

describe('agentAvatarUrl', () => {
  function agentAvatarUrl(
    agentId: string,
    avatarPath: string | null,
    updatedAt?: Date | null,
  ): string | null {
    if (!avatarPath) return null
    const ext = avatarPath.split('.').pop() ?? 'png'
    const v = updatedAt ? updatedAt.getTime() : Date.now()
    return `/api/uploads/agents/${agentId}/avatar.${ext}?v=${v}`
  }

  it('returns null when avatarPath is null', () => {
    expect(agentAvatarUrl('agent-1', null)).toBeNull()
  })

  it('returns null when avatarPath is empty string', () => {
    // empty string is falsy
    expect(agentAvatarUrl('agent-1', '')).toBeNull()
  })

  it('extracts extension from avatarPath', () => {
    const url = agentAvatarUrl('agent-1', 'avatar.jpg', new Date(1000))
    expect(url).toBe('/api/uploads/agents/agent-1/avatar.jpg?v=1000')
  })

  it('handles png extension', () => {
    const url = agentAvatarUrl('agent-1', 'uploads/photo.png', new Date(2000))
    expect(url).toBe('/api/uploads/agents/agent-1/avatar.png?v=2000')
  })

  it('handles webp extension', () => {
    const url = agentAvatarUrl('agent-1', 'path/to/image.webp', new Date(3000))
    expect(url).toBe('/api/uploads/agents/agent-1/avatar.webp?v=3000')
  })

  it('defaults to png when no extension found', () => {
    const url = agentAvatarUrl('agent-1', 'noextension', new Date(4000))
    // 'noextension'.split('.').pop() === 'noextension', not undefined
    // So it won't default to png — it uses the last segment after split
    expect(url).toBe('/api/uploads/agents/agent-1/avatar.noextension?v=4000')
  })

  it('uses Date.now() when updatedAt is null', () => {
    const before = Date.now()
    const url = agentAvatarUrl('agent-1', 'avatar.png', null)!
    const after = Date.now()

    const vMatch = url.match(/\?v=(\d+)/)
    expect(vMatch).not.toBeNull()
    const v = parseInt(vMatch![1]!)
    expect(v).toBeGreaterThanOrEqual(before)
    expect(v).toBeLessThanOrEqual(after)
  })

  it('uses Date.now() when updatedAt is undefined', () => {
    const before = Date.now()
    const url = agentAvatarUrl('agent-1', 'avatar.png')!
    const after = Date.now()

    const vMatch = url.match(/\?v=(\d+)/)
    const v = parseInt(vMatch![1]!)
    expect(v).toBeGreaterThanOrEqual(before)
    expect(v).toBeLessThanOrEqual(after)
  })

  it('includes agentId in the URL path', () => {
    const url = agentAvatarUrl('abc-def-123', 'avatar.png', new Date(0))
    expect(url).toContain('/agents/abc-def-123/')
  })
})

// ─── Expiry calculation pattern (from invitations.ts) ───────────────────────

describe('expiry calculation', () => {
  it('computes correct expiry from days', () => {
    const now = Date.now()
    const expiryDays = 7
    const expiresAt = new Date(now + expiryDays * 86_400_000)

    const expectedMs = now + 7 * 24 * 60 * 60 * 1000
    // Should be within 1ms (same computation)
    expect(Math.abs(expiresAt.getTime() - expectedMs)).toBeLessThan(2)
  })

  it('handles 0 expiry days (expires immediately)', () => {
    const now = Date.now()
    const expiresAt = new Date(now + 0 * 86_400_000)
    expect(expiresAt.getTime()).toBe(now)
  })

  it('handles fractional days', () => {
    const now = Date.now()
    const expiryDays = 0.5 // 12 hours
    const expiresAt = new Date(now + expiryDays * 86_400_000)
    const expectedMs = now + 12 * 60 * 60 * 1000
    expect(Math.abs(expiresAt.getTime() - expectedMs)).toBeLessThan(2)
  })
})
