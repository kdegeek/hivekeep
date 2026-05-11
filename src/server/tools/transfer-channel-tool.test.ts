import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { fullMockSchema, fullMockDrizzleOrm } from '../../test-helpers'
import type { ToolRegistration } from '@/server/tools/types'

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockGetChannel = mock(() => Promise.resolve(null as any))
const mockGetChannelOriginMeta = mock(() => undefined as any)
const mockSetChannelTransferHint = mock(() => undefined)
const mockResolveKinId = mock(() => null as string | null)
const mockBroadcast = mock(() => undefined)

// Capture inserts and updates so tests can assert on them
const insertedRows: any[] = []
const updates: any[] = []

// dbSelectQueue: each call to dbChain.get() returns the next item in this
// queue. transfer_channel.execute() performs two kin lookups (source then
// target); the tests pre-seed both rows in the order they will be consumed.
let dbSelectQueue: any[] = []
const dbChain: any = {
  select: mock(() => dbChain),
  from: mock(() => dbChain),
  where: mock(() => dbChain),
  get: mock(() => (dbSelectQueue.length > 0 ? dbSelectQueue.shift() : null)),
  insert: mock(() => dbChain),
  values: mock((row: any) => {
    insertedRows.push(row)
    return dbChain
  }),
  update: mock(() => ({
    set: mock((vals: any) => ({
      where: mock(() => {
        updates.push(vals)
        return Promise.resolve()
      }),
    })),
  })),
}

// Pure in-memory queue meta stubs so other test files that load
// @/server/services/channels through the poisoned module cache still find
// the sideband helpers they expect (mock.module is process-global in Bun).
const _queueMeta = new Map<string, any>()
const _originMeta = new Map<string, any>()
const _transferHints = new Map<string, any>()

mock.module('@/server/services/channels', () => ({
  // Used by transfer_channel under test
  getChannel: mockGetChannel,
  getChannelOriginMeta: mockGetChannelOriginMeta,
  setChannelTransferHint: mockSetChannelTransferHint,
  // Pure in-memory sideband helpers (mirror the real implementation)
  setChannelQueueMeta: (id: string, meta: any) => { _queueMeta.set(id, meta) },
  getChannelQueueMeta: (id: string) => _queueMeta.get(id),
  popChannelQueueMeta: (id: string) => {
    const meta = _queueMeta.get(id)
    if (meta) _queueMeta.delete(id)
    return meta
  },
  setChannelOriginMeta: (id: string, meta: any) => { _originMeta.set(id, meta) },
  popChannelTransferHint: (id: string) => {
    const h = _transferHints.get(id)
    if (h) _transferHints.delete(id)
    return h
  },
  // Re-exports referenced by channel-tools.ts but not under test here
  listChannels: mock(() => Promise.resolve([])),
  listChannelConversations: mock(() => Promise.resolve({ users: [], chatIds: [] })),
  createChannel: mock(() => Promise.resolve({})),
  updateChannel: mock(() => Promise.resolve({})),
  deleteChannel: mock(() => Promise.resolve()),
  activateChannel: mock(() => Promise.resolve({})),
  deactivateChannel: mock(() => Promise.resolve({})),
  testChannel: mock(() => Promise.resolve({ valid: true })),
  handleIncomingChannelMessage: mock(() => Promise.resolve()),
  deliverChannelResponse: mock(() => Promise.resolve()),
  findContactByPlatformId: mock(() => undefined),
  listPendingUsers: mock(() => Promise.resolve([])),
  approveChannelUser: mock(() => Promise.resolve()),
  countPendingApprovals: mock(() => Promise.resolve(0)),
  countPendingApprovalsForChannel: mock(() => Promise.resolve(0)),
  listContactPlatformIds: mock(() => []),
  addContactPlatformId: mock(() => ({})),
  removeContactPlatformId: mock(() => true),
  getActiveChannelsForKin: () => [],
  restoreActiveChannels: async () => {},
  resolveChannelLocale: () => 'en',
}))

mock.module('@/server/services/kin-resolver', () => ({
  resolveKinId: mockResolveKinId,
  resolveKinByIdOrSlug: mock(() => null),
}))

mock.module('@/server/db/index', () => ({ db: dbChain }))

mock.module('@/server/db/schema', () => ({
  ...fullMockSchema,
  kins: { id: 'id', slug: 'slug', name: 'name' },
  messages: { id: 'id', kinId: 'kinId', role: 'role', sourceType: 'sourceType', metadata: 'metadata' },
  channels: { id: 'id', kinId: 'kinId', updatedAt: 'updatedAt' },
}))

mock.module('@/server/channels/index', () => ({
  channelAdapters: {
    get: () => undefined,
    has: () => false,
    list: () => [],
  },
}))

mock.module('@/server/sse/index', () => ({
  sseManager: { broadcast: mockBroadcast, sendToKin: () => undefined },
}))

mock.module('@/server/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

mock.module('drizzle-orm', () => ({
  ...fullMockDrizzleOrm,
  eq: (...args: unknown[]) => args,
}))

// Import after mocks (Bun mock.module() is process-global and other test files
// may have poisoned exports; fall back to it.skip if so, mirroring the pattern
// used by task-tools.test.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let transferChannelTool: any
let _mocksWorking = false
try {
  const mod = await import('@/server/tools/channel-tools')
  transferChannelTool = mod.transferChannelTool
  _mocksWorking = !!transferChannelTool
} catch {
  _mocksWorking = false
}

const itMocked = _mocksWorking ? it : it.skip

// ─── Helpers ─────────────────────────────────────────────────────────────────

function executeTool(registration: ToolRegistration, input: Record<string, unknown> = {}, ctxOverrides: Record<string, unknown> = {}) {
  const t = registration.create({
    kinId: 'caller-kin',
    isSubKin: false,
    ...ctxOverrides,
  })
  return (t as any).execute(input, { toolCallId: 'tc-1', messages: [], abortSignal: new AbortController().signal })
}

beforeEach(() => {
  mockGetChannel.mockReset()
  mockGetChannelOriginMeta.mockReset()
  mockSetChannelTransferHint.mockReset()
  mockResolveKinId.mockReset()
  mockBroadcast.mockReset()
  insertedRows.length = 0
  updates.length = 0
  dbSelectQueue = []
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('transferChannelTool', () => {
  itMocked('happy path: mutates binding, inserts two audit rows, sets hint, broadcasts SSE', async () => {
    mockGetChannel.mockResolvedValue({ id: 'ch-1', name: 'WhatsApp main', kinId: 'kin-source' })
    mockResolveKinId.mockReturnValue('kin-target')
    // First get() = source Kin row, second get() = target Kin row
    dbSelectQueue = [
      { id: 'kin-source', slug: 'kinbot-master', name: 'KinBot Master' },
      { id: 'kin-target', slug: 'kube-master', name: 'Kube Master' },
    ]

    const result = await executeTool(transferChannelTool, {
      channelId: 'ch-1',
      targetKinSlug: 'kube-master',
      reason: 'Nicolas wants to talk to Kube Master about the cluster',
    })

    expect(result.ok).toBe(true)
    expect(result.noop).toBeUndefined()
    expect(result.previousKinSlug).toBe('kinbot-master')
    expect(result.newKinSlug).toBe('kube-master')

    // Binding was mutated to target
    expect(updates).toHaveLength(1)
    expect(updates[0]!.kinId).toBe('kin-target')

    // Two audit rows, one per Kin, with the right systemEvent discriminator
    expect(insertedRows).toHaveLength(2)
    const fromRow = insertedRows.find((r) => r.kinId === 'kin-source')!
    const toRow = insertedRows.find((r) => r.kinId === 'kin-target')!
    expect(fromRow).toBeDefined()
    expect(toRow).toBeDefined()
    expect(fromRow.role).toBe('system')
    expect(fromRow.sourceType).toBe('system')
    expect(toRow.role).toBe('system')
    expect(toRow.sourceType).toBe('system')
    const fromMeta = JSON.parse(fromRow.metadata)
    const toMeta = JSON.parse(toRow.metadata)
    expect(fromMeta.systemEvent).toBe('channel_transferred_out')
    expect(fromMeta.targetKinSlug).toBe('kube-master')
    expect(fromMeta.reason).toBe('Nicolas wants to talk to Kube Master about the cluster')
    expect(toMeta.systemEvent).toBe('channel_transferred_in')
    expect(toMeta.fromKinSlug).toBe('kinbot-master')
    expect(toMeta.reason).toBe('Nicolas wants to talk to Kube Master about the cluster')

    // Sideband hint was set with the source Kin info
    expect(mockSetChannelTransferHint).toHaveBeenCalledTimes(1)
    // Bun's mock typings narrow `calls` to `[]` for variadic mocks; cast to any
    // for argument inspection.
    const hintCall = (mockSetChannelTransferHint.mock.calls as any[])[0]
    expect(hintCall[0]).toBe('ch-1')
    const hint = hintCall[1] as { fromKinSlug: string; fromKinName: string; reason?: string }
    expect(hint.fromKinSlug).toBe('kinbot-master')
    expect(hint.fromKinName).toBe('KinBot Master')
    expect(hint.reason).toBe('Nicolas wants to talk to Kube Master about the cluster')

    // SSE broadcast fired with the full transfer payload
    expect(mockBroadcast).toHaveBeenCalledTimes(1)
    const event = (mockBroadcast.mock.calls as any[])[0][0] as { type: string; data: Record<string, unknown> }
    expect(event.type).toBe('channel:transferred')
    expect(event.data.channelId).toBe('ch-1')
    expect(event.data.fromKinSlug).toBe('kinbot-master')
    expect(event.data.toKinSlug).toBe('kube-master')
    expect(event.data.reason).toBe('Nicolas wants to talk to Kube Master about the cluster')
  })

  itMocked('returns a no-op when the target Kin is already the bound Kin', async () => {
    mockGetChannel.mockResolvedValue({ id: 'ch-1', name: 'WhatsApp main', kinId: 'kin-target' })
    mockResolveKinId.mockReturnValue('kin-target')

    const result = await executeTool(transferChannelTool, {
      channelId: 'ch-1',
      targetKinSlug: 'kube-master',
    })

    expect(result.ok).toBe(true)
    expect(result.noop).toBe(true)
    expect(insertedRows).toHaveLength(0)
    expect(updates).toHaveLength(0)
    expect(mockSetChannelTransferHint).not.toHaveBeenCalled()
    expect(mockBroadcast).not.toHaveBeenCalled()
  })

  itMocked('returns an error when the channel does not exist', async () => {
    mockGetChannel.mockResolvedValue(null)

    const result = await executeTool(transferChannelTool, {
      channelId: 'ch-missing',
      targetKinSlug: 'kube-master',
    })

    expect(result.error).toContain('Channel "ch-missing" not found')
    expect(insertedRows).toHaveLength(0)
    expect(updates).toHaveLength(0)
  })

  itMocked('returns an error when the target Kin cannot be resolved', async () => {
    mockGetChannel.mockResolvedValue({ id: 'ch-1', name: 'WhatsApp main', kinId: 'kin-source' })
    mockResolveKinId.mockReturnValue(null)

    const result = await executeTool(transferChannelTool, {
      channelId: 'ch-1',
      targetKinSlug: 'no-such-kin',
    })

    expect(result.error).toContain('Kin "no-such-kin" not found')
    expect(updates).toHaveLength(0)
  })

  itMocked('errors out when channelId is missing and cannot be inferred from the context', async () => {
    const result = await executeTool(transferChannelTool, {
      targetKinSlug: 'kube-master',
    })

    expect(result.error).toContain('channelId could not be inferred')
    expect(mockGetChannel).not.toHaveBeenCalled()
  })

  itMocked('infers channelId from ctx.channelOriginId when not passed explicitly', async () => {
    mockGetChannelOriginMeta.mockReturnValue({
      channelId: 'ch-from-context',
      platformChatId: 'chat-1',
      platformMessageId: 'msg-1',
      platformUserId: 'usr-1',
      createdAt: Date.now(),
      ttlMs: 60000,
    })
    mockGetChannel.mockResolvedValue({ id: 'ch-from-context', name: 'Discord main', kinId: 'kin-source' })
    mockResolveKinId.mockReturnValue('kin-target')
    dbSelectQueue = [
      { id: 'kin-source', slug: 'kinbot-master', name: 'KinBot Master' },
      { id: 'kin-target', slug: 'kube-master', name: 'Kube Master' },
    ]

    const result = await executeTool(
      transferChannelTool,
      { targetKinSlug: 'kube-master' },
      { channelOriginId: 'queue-item-42' },
    )

    expect(result.ok).toBe(true)
    expect(mockGetChannel).toHaveBeenCalledWith('ch-from-context')
    expect(updates[0]!.kinId).toBe('kin-target')
  })

  // Zod-level validation: reason over 200 chars rejected by the schema. The
  // Vercel AI SDK exposes the parsed schema as `inputSchema`. Validate
  // directly so the assertion is independent of how the SDK wires up
  // runtime validation under .execute().
  itMocked('rejects a reason longer than 200 characters via the Zod schema', async () => {
    const tooLong = 'x'.repeat(201)
    const t = transferChannelTool.create({ kinId: 'caller-kin', isSubKin: false })
    const parsed = t.inputSchema.safeParse({ channelId: 'ch-1', targetKinSlug: 's', reason: tooLong })
    expect(parsed.success).toBe(false)
  })
})
