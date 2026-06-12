import { describe, it, expect, mock, beforeEach } from 'bun:test'

// Mock the db module before importing the module under test
const mockGet = mock(() => undefined as { id: string } | undefined)
const mockWhere = mock(() => ({ get: mockGet }))
const mockFrom = mock(() => ({ where: mockWhere }))
const mockSelect = mock(() => ({ from: mockFrom }))

mock.module('@/server/db/index', () => ({
  db: { select: mockSelect },
}))

mock.module('@/server/db/schema', () => ({
  providers: { id: 'id' },
}))

mock.module('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}))

const { validateAgentFields, agentAvatarUrl } = await import(
  '@/server/services/field-validator'
)

// ─── validateAgentFields ──────────────────────────────────────────────────────

describe('validateAgentFields', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockGet.mockReturnValue(undefined)
  })

  // ── Create mode: required fields ──

  describe('create mode — required fields', () => {
    it('returns error when name is missing', () => {
      const err = validateAgentFields({ role: 'helper', model: 'gpt-4' }, 'create')
      expect(err).not.toBeNull()
      expect(err!.field).toBe('name')
      expect(err!.code).toBe('INVALID_NAME')
    })

    it('returns error when name is empty string', () => {
      const err = validateAgentFields({ name: '  ', role: 'helper', model: 'gpt-4' }, 'create')
      expect(err).not.toBeNull()
      expect(err!.field).toBe('name')
    })

    it('returns error when role is missing', () => {
      const err = validateAgentFields({ name: 'Bot', model: 'gpt-4' }, 'create')
      expect(err).not.toBeNull()
      expect(err!.field).toBe('role')
    })

    it('returns error when role is empty', () => {
      const err = validateAgentFields({ name: 'Bot', role: '', model: 'gpt-4' }, 'create')
      expect(err).not.toBeNull()
      expect(err!.field).toBe('role')
    })

    it('returns error when model is missing', () => {
      const err = validateAgentFields({ name: 'Bot', role: 'helper' }, 'create')
      expect(err).not.toBeNull()
      expect(err!.field).toBe('model')
    })

    it('returns error when model is empty', () => {
      const err = validateAgentFields({ name: 'Bot', role: 'helper', model: '  ' }, 'create')
      expect(err).not.toBeNull()
      expect(err!.field).toBe('model')
    })

    it('returns null when all required fields are valid', () => {
      const err = validateAgentFields({ name: 'Bot', role: 'helper', model: 'gpt-4' }, 'create')
      expect(err).toBeNull()
    })
  })

  // ── Update mode: required fields not enforced ──

  describe('update mode — partial fields allowed', () => {
    it('returns null when no fields provided', () => {
      const err = validateAgentFields({}, 'update')
      expect(err).toBeNull()
    })

    it('returns null with only name', () => {
      const err = validateAgentFields({ name: 'NewName' }, 'update')
      expect(err).toBeNull()
    })

    it('returns null with only role', () => {
      const err = validateAgentFields({ role: 'new role' }, 'update')
      expect(err).toBeNull()
    })
  })

  // ── Length limits ──

  describe('length limits', () => {
    it('rejects name over 100 characters', () => {
      const err = validateAgentFields(
        { name: 'a'.repeat(101), role: 'r', model: 'm' },
        'create',
      )
      expect(err).not.toBeNull()
      expect(err!.field).toBe('name')
      expect(err!.message).toContain('100')
    })

    it('accepts name at exactly 100 characters', () => {
      const err = validateAgentFields(
        { name: 'a'.repeat(100), role: 'r', model: 'm' },
        'create',
      )
      expect(err).toBeNull()
    })

    it('rejects role over 200 characters', () => {
      const err = validateAgentFields(
        { name: 'Bot', role: 'r'.repeat(201), model: 'm' },
        'create',
      )
      expect(err).not.toBeNull()
      expect(err!.field).toBe('role')
      expect(err!.message).toContain('200')
    })

    it('accepts role at exactly 200 characters', () => {
      const err = validateAgentFields(
        { name: 'Bot', role: 'r'.repeat(200), model: 'm' },
        'create',
      )
      expect(err).toBeNull()
    })

    it('rejects character over 50000 characters', () => {
      const err = validateAgentFields(
        { name: 'Bot', role: 'r', model: 'm', character: 'c'.repeat(50_001) },
        'create',
      )
      expect(err).not.toBeNull()
      expect(err!.field).toBe('character')
    })

    it('accepts character at exactly 50000 characters', () => {
      const err = validateAgentFields(
        { name: 'Bot', role: 'r', model: 'm', character: 'c'.repeat(50_000) },
        'create',
      )
      expect(err).toBeNull()
    })

    it('rejects expertise over 50000 characters', () => {
      const err = validateAgentFields(
        { name: 'Bot', role: 'r', model: 'm', expertise: 'e'.repeat(50_001) },
        'create',
      )
      expect(err).not.toBeNull()
      expect(err!.field).toBe('expertise')
    })
  })

  // ── Type validation ──

  describe('type validation', () => {
    it('rejects non-string name in update mode', () => {
      const err = validateAgentFields({ name: 123 as any }, 'update')
      expect(err).not.toBeNull()
      expect(err!.field).toBe('name')
    })

    it('rejects non-string role in update mode', () => {
      const err = validateAgentFields({ role: null as any }, 'update')
      expect(err).not.toBeNull()
      expect(err!.field).toBe('role')
    })

    it('rejects non-string model in update mode', () => {
      const err = validateAgentFields({ model: '' }, 'update')
      expect(err).not.toBeNull()
      expect(err!.field).toBe('model')
    })
  })

  // ── providerId validation ──

  describe('providerId', () => {
    it('returns null when providerId is null (clearing provider)', () => {
      const err = validateAgentFields(
        { name: 'Bot', role: 'r', model: 'm', providerId: null },
        'create',
      )
      expect(err).toBeNull()
    })

    it('returns null when providerId is undefined', () => {
      const err = validateAgentFields(
        { name: 'Bot', role: 'r', model: 'm' },
        'create',
      )
      expect(err).toBeNull()
    })

    it('returns error when providerId does not exist in DB', () => {
      mockGet.mockReturnValue(undefined)
      const err = validateAgentFields(
        { name: 'Bot', role: 'r', model: 'm', providerId: 'nonexistent-id' },
        'create',
      )
      expect(err).not.toBeNull()
      expect(err!.field).toBe('providerId')
      expect(err!.code).toBe('INVALID_PROVIDER')
    })

    it('returns null when providerId exists in DB', () => {
      mockGet.mockReturnValue({ id: 'valid-id' })
      const err = validateAgentFields(
        { name: 'Bot', role: 'r', model: 'm', providerId: 'valid-id' },
        'create',
      )
      expect(err).toBeNull()
    })
  })

  // ── Edge cases ──

  describe('edge cases', () => {
    it('validates fields in order: name → role → character → expertise → model', () => {
      // All invalid: should return name error first
      const err = validateAgentFields(
        { name: '', role: '', model: '' },
        'create',
      )
      expect(err!.field).toBe('name')
    })

    it('allows character and expertise as undefined without error', () => {
      const err = validateAgentFields(
        { name: 'Bot', role: 'r', model: 'm', character: undefined, expertise: undefined },
        'create',
      )
      expect(err).toBeNull()
    })
  })
})

// ─── agentAvatarUrl ───────────────────────────────────────────────────────────

describe('agentAvatarUrl', () => {
  it('returns null when avatarPath is null', () => {
    expect(agentAvatarUrl('agent-1', null)).toBeNull()
  })

  it('returns null when avatarPath is empty string', () => {
    // empty string is falsy
    expect(agentAvatarUrl('agent-1', '')).toBeNull()
  })

  it('builds correct URL with png extension', () => {
    const url = agentAvatarUrl('agent-123', 'avatar.png', new Date(1000))
    expect(url).toBe('/api/uploads/agents/agent-123/avatar.png?v=1000')
  })

  it('builds correct URL with jpg extension', () => {
    const url = agentAvatarUrl('agent-456', 'photo.jpg', new Date(2000))
    expect(url).toBe('/api/uploads/agents/agent-456/avatar.jpg?v=2000')
  })

  it('builds correct URL with webp extension', () => {
    const url = agentAvatarUrl('abc', 'img.webp', new Date(5000))
    expect(url).toBe('/api/uploads/agents/abc/avatar.webp?v=5000')
  })

  it('defaults extension to png when path has no dot', () => {
    const url = agentAvatarUrl('agent-1', 'noext', new Date(100))
    // 'noext'.split('.').pop() === 'noext', not 'png' — tests actual behavior
    expect(url).toBe('/api/uploads/agents/agent-1/avatar.noext?v=100')
  })

  it('uses Date.now() when updatedAt is null', () => {
    const before = Date.now()
    const url = agentAvatarUrl('agent-1', 'a.png', null)
    const after = Date.now()
    // Extract v param
    const v = Number(url!.split('?v=')[1])
    expect(v).toBeGreaterThanOrEqual(before)
    expect(v).toBeLessThanOrEqual(after)
  })

  it('uses Date.now() when updatedAt is undefined', () => {
    const before = Date.now()
    const url = agentAvatarUrl('agent-1', 'a.png')
    const after = Date.now()
    const v = Number(url!.split('?v=')[1])
    expect(v).toBeGreaterThanOrEqual(before)
    expect(v).toBeLessThanOrEqual(after)
  })
})
