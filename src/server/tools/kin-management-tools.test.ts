import { describe, it, expect, mock } from 'bun:test'
import { fullMockConfig } from '../../test-helpers'

// ─── Mocks ──────────────────────────────────────────────────────────────────

mock.module('@/server/config', () => ({ config: { ...fullMockConfig } }))

const mockCreateKin = mock(() => Promise.resolve({
  id: 'new-kin-id',
  slug: 'test-kin',
  name: 'Test Kin',
  role: 'Assistant',
  model: 'gpt-4o',
}))

const mockUpdateKin = mock(() => Promise.resolve({
  kin: {
    id: 'target-kin-id',
    slug: 'updated-kin',
    name: 'Updated Kin',
    role: 'Updated Role',
    model: 'gpt-4o',
    avatarUrl: null,
  },
} as any))

const mockDeleteKin = mock(() => Promise.resolve(true))

const mockGetKinDetails = mock(() => Promise.resolve({
  id: 'target-kin-id',
  slug: 'target-kin',
  name: 'Target Kin',
  role: 'Helper',
  character: 'Friendly',
  expertise: 'Everything',
  model: 'gpt-4o',
  mcpServers: [] as any[],
  toolboxIds: null as string | null,
  createdAt: new Date(),
}))

// Toolbox lookups used by update_kin (name → id) and get_kin_details (id → name).
// A small in-memory registry covering the built-ins the tests reference.
const TOOLBOX_REGISTRY: Record<string, { id: string; name: string }> = {
  code: { id: 'tb-code', name: 'code' },
  research: { id: 'tb-research', name: 'research' },
  all: { id: 'tb-all', name: 'all' },
}
const TOOLBOX_BY_ID: Record<string, { id: string; name: string }> = Object.fromEntries(
  Object.values(TOOLBOX_REGISTRY).map((b) => [b.id, b]),
)
const mockGetToolboxByName = mock((name: string) => TOOLBOX_REGISTRY[name] ?? null)
const mockGetToolbox = mock((id: string) => TOOLBOX_BY_ID[id] ?? null)

const mockGenerateAndSaveAvatar = mock(() => Promise.resolve('/api/uploads/kins/new-kin-id/avatar.png'))

const mockResolveKinId = mock((idOrSlug: string) => {
  if (idOrSlug === 'not-found') return null
  if (idOrSlug === 'self-kin') return 'self-kin-id'
  return 'target-kin-id'
})

mock.module('@/server/services/kins', () => ({
  createKin: mockCreateKin,
  updateKin: mockUpdateKin,
  deleteKin: mockDeleteKin,
  getKinDetails: mockGetKinDetails,
  generateAndSaveAvatar: mockGenerateAndSaveAvatar,
}))

mock.module('@/server/services/kin-resolver', () => ({
  resolveKinId: mockResolveKinId,
}))

mock.module('@/server/services/toolboxes', () => ({
  getToolboxByName: mockGetToolboxByName,
  getToolbox: mockGetToolbox,
}))

mock.module('@/server/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}))

// Import after mocks. Wrapped in try/catch to degrade gracefully if
// Bun mock.module() poisoned exports of @/server/services/custom-tools (or
// any transitive dep) from a previous test file in the same process,
// see known issue #325. Tests fall back to it.skip on failure.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createKinTool: any, updateKinTool: any, deleteKinTool: any, getKinDetailsTool: any
let _mocksWorking = false
try {
  const mod = await import('./kin-management-tools')
  createKinTool = mod.createKinTool
  updateKinTool = mod.updateKinTool
  deleteKinTool = mod.deleteKinTool
  getKinDetailsTool = mod.getKinDetailsTool
  _mocksWorking = true
} catch {
  _mocksWorking = false
}

const itMocked = _mocksWorking ? it : it.skip

// ─── Helpers ────────────────────────────────────────────────────────────────

function createCtx(overrides?: Partial<{ kinId: string; userId: string; taskId: string }>) {
  return {
    kinId: overrides?.kinId ?? 'self-kin-id',
    userId: overrides?.userId ?? 'user-1',
    taskId: overrides?.taskId,
  }
}

function makeTool(registration: any, ctx?: any) {
  return registration.create(ctx ?? createCtx())
}

// ─── createKinTool ──────────────────────────────────────────────────────────

describe('createKinTool', () => {
  itMocked('has correct availability', () => {
    expect(createKinTool.availability).toEqual(['main'])
    expect(createKinTool.defaultDisabled).toBe(true)
  })

  itMocked('creates a kin and returns its details', async () => {
    mockCreateKin.mockResolvedValueOnce({
      id: 'new-kin-id',
      slug: 'my-helper',
      name: 'My Helper',
      role: 'Research Assistant',
      model: 'claude-sonnet-4-20250514',
    })

    const t = makeTool(createKinTool)
    const result = await t.execute({
      name: 'My Helper',
      role: 'Research Assistant',
      character: 'Thoughtful and thorough',
      expertise: 'Web research and summarization',
      model: 'claude-sonnet-4-20250514',
      generate_avatar: false,
    }, { toolCallId: 'tc1', messages: [] })

    expect(result).toEqual({
      id: 'new-kin-id',
      slug: 'my-helper',
      name: 'My Helper',
      role: 'Research Assistant',
      model: 'claude-sonnet-4-20250514',
      avatarUrl: null,
    })
    expect(mockCreateKin).toHaveBeenCalledWith({
      name: 'My Helper',
      role: 'Research Assistant',
      character: 'Thoughtful and thorough',
      expertise: 'Web research and summarization',
      model: 'claude-sonnet-4-20250514',
      createdBy: 'user-1',
    })
  })

  itMocked('generates avatar when requested', async () => {
    mockCreateKin.mockResolvedValueOnce({
      id: 'avatar-kin',
      slug: 'avatar-kin',
      name: 'Avatar Kin',
      role: 'Tester',
      model: 'gpt-4o',
    })
    mockGenerateAndSaveAvatar.mockResolvedValueOnce('/avatar.png')

    const t = makeTool(createKinTool)
    const result = await t.execute({
      name: 'Avatar Kin',
      role: 'Tester',
      character: 'Friendly',
      expertise: 'Testing',
      model: 'gpt-4o',
      generate_avatar: true,
    }, { toolCallId: 'tc2', messages: [] })

    expect(result.avatarUrl).toBe('/avatar.png')
    expect(mockGenerateAndSaveAvatar).toHaveBeenCalledWith('avatar-kin')
  })

  itMocked('returns result even if avatar generation fails', async () => {
    mockCreateKin.mockResolvedValueOnce({
      id: 'fail-avatar',
      slug: 'fail-avatar',
      name: 'Fail Avatar',
      role: 'Tester',
      model: 'gpt-4o',
    })
    mockGenerateAndSaveAvatar.mockRejectedValueOnce(new Error('No image provider'))

    const t = makeTool(createKinTool)
    const result = await t.execute({
      name: 'Fail Avatar',
      role: 'Tester',
      character: 'Test',
      expertise: 'Test',
      model: 'gpt-4o',
      generate_avatar: true,
    }, { toolCallId: 'tc3', messages: [] })

    expect(result.id).toBe('fail-avatar')
    expect(result.avatarUrl).toBeNull()
  })

  itMocked('returns error when creation fails', async () => {
    mockCreateKin.mockRejectedValueOnce(new Error('Duplicate name'))

    const t = makeTool(createKinTool)
    const result = await t.execute({
      name: 'Duplicate',
      role: 'Test',
      character: 'Test',
      expertise: 'Test',
      model: 'gpt-4o',
      generate_avatar: false,
    }, { toolCallId: 'tc4', messages: [] })

    expect(result).toEqual({ error: 'Duplicate name' })
  })

  itMocked('uses null as createdBy when no userId in context', async () => {
    mockCreateKin.mockResolvedValueOnce({
      id: 'sys-kin',
      slug: 'sys-kin',
      name: 'System Kin',
      role: 'Test',
      model: 'gpt-4o',
    })

    const t = makeTool(createKinTool, { kinId: 'some-kin', userId: undefined })
    await t.execute({
      name: 'System Kin',
      role: 'Test',
      character: 'Test',
      expertise: 'Test',
      model: 'gpt-4o',
      generate_avatar: false,
    }, { toolCallId: 'tc5', messages: [] })

    expect(mockCreateKin).toHaveBeenLastCalledWith(expect.objectContaining({
      createdBy: null,
    }))
  })
})

// ─── updateKinTool ──────────────────────────────────────────────────────────

describe('updateKinTool', () => {
  itMocked('has correct availability', () => {
    expect(updateKinTool.availability).toEqual(['main'])
    expect(updateKinTool.defaultDisabled).toBe(true)
  })

  itMocked('prevents self-modification', async () => {
    mockResolveKinId.mockReturnValueOnce('self-kin-id')

    const t = makeTool(updateKinTool, createCtx({ kinId: 'self-kin-id' }))
    const result = await t.execute({
      kin_id: 'self-kin',
      name: 'New Name',
      generate_avatar: false,
    }, { toolCallId: 'tc6', messages: [] })

    expect(result).toEqual({
      error: 'You cannot modify your own configuration. Ask a user or another Kin to do this.',
    })
  })

  itMocked('returns error when kin not found', async () => {
    mockResolveKinId.mockReturnValueOnce(null)

    const t = makeTool(updateKinTool)
    const result = await t.execute({
      kin_id: 'not-found',
      name: 'New Name',
      generate_avatar: false,
    }, { toolCallId: 'tc7', messages: [] })

    expect(result).toEqual({ error: 'Kin "not-found" not found' })
  })

  itMocked('updates a kin successfully', async () => {
    mockResolveKinId.mockReturnValueOnce('target-kin-id')
    mockUpdateKin.mockResolvedValueOnce({
      kin: {
        id: 'target-kin-id',
        slug: 'updated',
        name: 'Updated Name',
        role: 'New Role',
        model: 'gpt-4o',
        avatarUrl: null,
      },
    })

    const t = makeTool(updateKinTool)
    const result = await t.execute({
      kin_id: 'target-kin',
      name: 'Updated Name',
      role: 'New Role',
      generate_avatar: false,
    }, { toolCallId: 'tc8', messages: [] })

    expect(result.name).toBe('Updated Name')
    expect(result.role).toBe('New Role')
  })

  itMocked('returns error when updateKin returns error object', async () => {
    mockResolveKinId.mockReturnValueOnce('target-kin-id')
    mockUpdateKin.mockResolvedValueOnce({
      error: { message: 'Invalid slug format' },
    } as any)

    const t = makeTool(updateKinTool)
    const result = await t.execute({
      kin_id: 'target-kin',
      slug: 'BAD SLUG',
      generate_avatar: false,
    }, { toolCallId: 'tc9', messages: [] })

    expect(result).toEqual({ error: 'Invalid slug format' })
  })

  itMocked('rejects an unknown toolbox name', async () => {
    mockResolveKinId.mockReturnValueOnce('target-kin-id')

    const t = makeTool(updateKinTool)
    const result = await t.execute({
      kin_id: 'target-kin',
      toolboxes: ['does-not-exist'],
      generate_avatar: false,
    }, { toolCallId: 'tc10', messages: [] })

    expect(result).toEqual({
      error: 'Unknown toolbox "does-not-exist". Use list_toolboxes to see available toolboxes.',
    })
  })

  itMocked('resolves toolbox names to ids and passes toolboxIds to updateKin', async () => {
    mockResolveKinId.mockReturnValueOnce('target-kin-id')
    mockUpdateKin.mockResolvedValueOnce({
      kin: {
        id: 'target-kin-id',
        slug: 'target',
        name: 'Target',
        role: 'Role',
        model: 'gpt-4o',
        avatarUrl: null,
      },
    })

    const t = makeTool(updateKinTool)
    await t.execute({
      kin_id: 'target-kin',
      toolboxes: ['code', 'research'],
      generate_avatar: false,
    }, { toolCallId: 'tc11', messages: [] })

    expect(mockUpdateKin).toHaveBeenLastCalledWith('target-kin-id', expect.objectContaining({
      toolboxIds: ['tb-code', 'tb-research'],
    }))
  })

  itMocked('resets toolbox selection to the all default on empty array', async () => {
    mockResolveKinId.mockReturnValueOnce('target-kin-id')
    mockUpdateKin.mockResolvedValueOnce({
      kin: {
        id: 'target-kin-id',
        slug: 'target',
        name: 'Target',
        role: 'Role',
        model: 'gpt-4o',
        avatarUrl: null,
      },
    })

    const t = makeTool(updateKinTool)
    await t.execute({
      kin_id: 'target-kin',
      toolboxes: [],
      generate_avatar: false,
    }, { toolCallId: 'tc11b', messages: [] })

    expect(mockUpdateKin).toHaveBeenLastCalledWith('target-kin-id', expect.objectContaining({
      toolboxIds: null,
    }))
  })
})

// ─── deleteKinTool ──────────────────────────────────────────────────────────

describe('deleteKinTool', () => {
  itMocked('has correct availability', () => {
    expect(deleteKinTool.availability).toEqual(['main'])
    expect(deleteKinTool.defaultDisabled).toBe(true)
  })

  itMocked('prevents self-deletion', async () => {
    mockResolveKinId.mockReturnValueOnce('self-kin-id')

    const t = makeTool(deleteKinTool, createCtx({ kinId: 'self-kin-id' }))
    const result = await t.execute({
      kin_id: 'self-kin',
      confirm: true,
    }, { toolCallId: 'tc12', messages: [] })

    expect(result).toEqual({
      error: 'You cannot delete yourself. Ask a user or another Kin to do this.',
    })
  })

  itMocked('returns error when kin not found', async () => {
    mockResolveKinId.mockReturnValueOnce(null)

    const t = makeTool(deleteKinTool)
    const result = await t.execute({
      kin_id: 'not-found',
      confirm: true,
    }, { toolCallId: 'tc13', messages: [] })

    expect(result).toEqual({ error: 'Kin "not-found" not found' })
  })

  itMocked('deletes a kin successfully', async () => {
    mockResolveKinId.mockReturnValueOnce('target-kin-id')
    mockDeleteKin.mockResolvedValueOnce(true)

    const t = makeTool(deleteKinTool)
    const result = await t.execute({
      kin_id: 'target-kin',
      confirm: true,
    }, { toolCallId: 'tc14', messages: [] })

    expect(result).toEqual({ success: true, deletedKin: 'target-kin' })
  })

  itMocked('returns error when deleteKin returns false', async () => {
    mockResolveKinId.mockReturnValueOnce('target-kin-id')
    mockDeleteKin.mockResolvedValueOnce(false)

    const t = makeTool(deleteKinTool)
    const result = await t.execute({
      kin_id: 'gone-kin',
      confirm: true,
    }, { toolCallId: 'tc15', messages: [] })

    expect(result).toEqual({ error: 'Kin not found' })
  })

  itMocked('returns error when deleteKin throws', async () => {
    mockResolveKinId.mockReturnValueOnce('target-kin-id')
    mockDeleteKin.mockRejectedValueOnce(new Error('DB constraint'))

    const t = makeTool(deleteKinTool)
    const result = await t.execute({
      kin_id: 'target-kin',
      confirm: true,
    }, { toolCallId: 'tc16', messages: [] })

    expect(result).toEqual({ error: 'DB constraint' })
  })
})

// ─── getKinDetailsTool ──────────────────────────────────────────────────────

describe('getKinDetailsTool', () => {
  itMocked('has correct availability', () => {
    expect(getKinDetailsTool.availability).toEqual(['main'])
    expect(getKinDetailsTool.defaultDisabled).toBe(true)
  })

  itMocked('returns error when kin not found by resolver', async () => {
    mockResolveKinId.mockReturnValueOnce(null)

    const t = makeTool(getKinDetailsTool)
    const result = await t.execute({
      kin_id: 'not-found',
    }, { toolCallId: 'tc17', messages: [] })

    expect(result).toEqual({ error: 'Kin "not-found" not found' })
  })

  itMocked('returns error when getKinDetails returns null', async () => {
    mockResolveKinId.mockReturnValueOnce('target-kin-id')
    mockGetKinDetails.mockResolvedValueOnce(null as any)

    const t = makeTool(getKinDetailsTool)
    const result = await t.execute({
      kin_id: 'target-kin',
    }, { toolCallId: 'tc18', messages: [] })

    expect(result).toEqual({ error: 'Kin not found' })
  })

  itMocked('returns kin details with resolved toolbox names', async () => {
    mockResolveKinId.mockReturnValueOnce('target-kin-id')
    mockGetKinDetails.mockResolvedValueOnce({
      id: 'target-kin-id',
      slug: 'target',
      name: 'Target Kin',
      role: 'Helper',
      character: 'Friendly',
      expertise: 'Everything',
      model: 'gpt-4o',
      mcpServers: [{ id: 'mcp-1', name: 'My MCP' }] as any[],
      toolboxIds: JSON.stringify(['tb-code', 'tb-research']) as string | null,
      createdAt: new Date('2024-01-01'),
    })

    const t = makeTool(getKinDetailsTool)
    const result = await t.execute({
      kin_id: 'target',
    }, { toolCallId: 'tc19', messages: [] })

    expect(result.id).toBe('target-kin-id')
    expect(result.slug).toBe('target')
    expect(result.name).toBe('Target Kin')
    expect(result.mcpServers).toEqual([{ id: 'mcp-1', name: 'My MCP' }])
    expect(result.toolboxes).toEqual(['code', 'research'])
  })

  itMocked('reports the all default when no toolboxes are set', async () => {
    mockResolveKinId.mockReturnValueOnce('target-kin-id')
    mockGetKinDetails.mockResolvedValueOnce({
      id: 'target-kin-id',
      slug: 'target',
      name: 'Target Kin',
      role: 'Helper',
      character: 'Friendly',
      expertise: 'Everything',
      model: 'gpt-4o',
      mcpServers: [],
      toolboxIds: null,
      createdAt: new Date('2024-01-01'),
    })

    const t = makeTool(getKinDetailsTool)
    const result = await t.execute({
      kin_id: 'target',
    }, { toolCallId: 'tc20', messages: [] })

    expect(result.toolboxes).toEqual(['all'])
  })
})
