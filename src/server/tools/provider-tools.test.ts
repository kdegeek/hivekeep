import { describe, it, expect, mock, afterAll } from 'bun:test'
import type { ToolExecutionContext } from '@/server/tools/types'

// ─── Mocks ───────────────────────────────────────────────────────────────────
//
// bun's `mock.module` poisons the underlying binding globally and persists
// across test files (and the poisoning happens at module-LOAD time, before any
// afterAll restore can run). So we must avoid mocking modules that another
// suite re-imports for real. In particular we do NOT mock
// `@/server/services/provider-config`: provider-config.test.ts imports the real
// `loadProviderConfig` at load time and a stub here would leak into it. Instead
// we mock the leaf `encryption` dependency (identity, exactly as
// provider-config.test.ts does, so the leak is harmless): the real
// `loadProviderConfig` then runs and returns {} for our synthetic rows, which is
// fine because `listModelsForProvider` (mocked below) ignores the config.
//
// We still capture + restore the modules we do mock so they don't leak either.

const _realDbIndex = await import('@/server/db/index')
const _realDbSchema = await import('@/server/db/schema')
const _realProvidersIndex = await import('@/server/providers/index')
const _realEncryption = await import('@/server/services/encryption')
const _realLogger = await import('@/server/logger')

const mockDbAll = mock(() => Promise.resolve([] as unknown[]))
const mockDbSelect = mock(() => ({
  from: mock(() => ({
    all: mockDbAll,
  })),
}))

mock.module('@/server/db/index', () => ({
  ..._realDbIndex,
  db: {
    select: mockDbSelect,
  },
}))

mock.module('@/server/db/schema', () => ({
  ..._realDbSchema,
  providers: {},
}))

const mockListModelsForProvider = mock(() =>
  Promise.resolve([
    { id: 'gpt-4o', name: 'GPT-4o', capability: 'llm' },
  ]),
)

mock.module('@/server/providers/index', () => ({
  ..._realProvidersIndex,
  listModelsForProvider: mockListModelsForProvider,
}))

// Identity encryption so the real loadProviderConfig never opens the vault.
mock.module('@/server/services/encryption', () => ({
  ..._realEncryption,
  encrypt: async (s: string) => s,
  decrypt: async (s: string) => s,
}))

mock.module('@/server/logger', () => ({
  ..._realLogger,
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}))

afterAll(() => {
  mock.module('@/server/db/index', () => ({ ..._realDbIndex }))
  mock.module('@/server/db/schema', () => ({ ..._realDbSchema }))
  mock.module('@/server/providers/index', () => ({ ..._realProvidersIndex }))
  mock.module('@/server/services/encryption', () => ({ ..._realEncryption }))
  mock.module('@/server/logger', () => ({ ..._realLogger }))
})

// Import after mocks
const { listProvidersTool, listModelsTool } = await import('@/server/tools/provider-tools')

// ─── Helpers ─────────────────────────────────────────────────────────────────

const makeCtx = (overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
  agentId: 'agent-test-1',
  userId: 'user-1',
  isSubAgent: false,
  ...overrides,
})

function stubProviders(rows: unknown[]) {
  const mockFrom = mock(() => ({ all: mock(() => Promise.resolve(rows)) }))
  mockDbSelect.mockReturnValueOnce({ from: mockFrom } as any)
}

function makeProviderRow(opts: {
  id?: string
  slug?: string
  name?: string
  type?: string
  isValid?: boolean
  lastError?: string | null
  capabilities?: string[]
} = {}) {
  return {
    id: opts.id ?? 'p-1',
    slug: opts.slug ?? 'openai',
    name: opts.name ?? 'OpenAI',
    type: opts.type ?? 'openai',
    isValid: opts.isValid ?? true,
    lastError: opts.lastError ?? null,
    capabilities: JSON.stringify(opts.capabilities ?? ['llm']),
    configEncrypted: 'encrypted',
  }
}

// ─── listProvidersTool ───────────────────────────────────────────────────────

describe('listProvidersTool', () => {
  it('has correct availability and is read-only', () => {
    expect(listProvidersTool.availability).toEqual(['main', 'sub-agent'])
    expect(listProvidersTool.readOnly).toBe(true)
  })

  it('includes invalid providers with isValid and lastError so Queenie can diagnose a bad key', async () => {
    stubProviders([
      makeProviderRow({ id: 'p-good', slug: 'good', name: 'Good', isValid: true }),
      makeProviderRow({
        id: 'p-bad',
        slug: 'bad',
        name: 'Bad Key',
        isValid: false,
        lastError: '401 Unauthorized: invalid api key',
      }),
    ])

    const t = listProvidersTool.create(makeCtx())
    const result = await (t as any).execute({}, { toolCallId: 'tc-1', messages: [] })

    // Invalid providers must NOT be hidden.
    expect(result.providers.length).toBe(2)

    const good = result.providers.find((p: any) => p.id === 'p-good')
    expect(good.isValid).toBe(true)
    expect(good.lastError).toBeNull()

    const bad = result.providers.find((p: any) => p.id === 'p-bad')
    expect(bad).toBeDefined()
    expect(bad.isValid).toBe(false)
    expect(bad.lastError).toContain('401 Unauthorized')
  })

  it('keeps the existing output fields (backward-compatible)', async () => {
    stubProviders([makeProviderRow({ capabilities: ['llm', 'embedding'] })])

    const t = listProvidersTool.create(makeCtx())
    const result = await (t as any).execute({}, { toolCallId: 'tc-1', messages: [] })

    const p = result.providers[0]
    expect(p.id).toBe('p-1')
    expect(p.slug).toBe('openai')
    expect(p.name).toBe('OpenAI')
    expect(p.type).toBe('openai')
    expect(p.capabilities).toEqual(['llm', 'embedding'])
  })

  it('normalizes a null lastError on a valid provider', async () => {
    stubProviders([makeProviderRow({ isValid: true, lastError: null })])

    const t = listProvidersTool.create(makeCtx())
    const result = await (t as any).execute({}, { toolCallId: 'tc-1', messages: [] })

    expect(result.providers[0].lastError).toBeNull()
  })
})

// ─── listModelsTool ──────────────────────────────────────────────────────────

describe('listModelsTool', () => {
  it('has correct availability and is read-only', () => {
    expect(listModelsTool.availability).toEqual(['main', 'sub-agent'])
    expect(listModelsTool.readOnly).toBe(true)
  })

  it('returns models from valid providers and an empty invalidProviders array', async () => {
    stubProviders([makeProviderRow({ capabilities: ['llm'] })])

    const t = listModelsTool.create(makeCtx())
    const result = await (t as any).execute({}, { toolCallId: 'tc-1', messages: [] })

    expect(result.models.length).toBe(1)
    expect(result.models[0].id).toBe('gpt-4o')
    expect(result.invalidProviders).toEqual([])
  })

  it('does not skip invalid providers silently: reports them in invalidProviders with lastError', async () => {
    stubProviders([
      makeProviderRow({ id: 'p-good', slug: 'good', name: 'Good', capabilities: ['llm'] }),
      makeProviderRow({
        id: 'p-bad',
        slug: 'bad',
        name: 'Bad Key',
        isValid: false,
        lastError: '403 Forbidden',
      }),
    ])

    const t = listModelsTool.create(makeCtx())
    const result = await (t as any).execute({}, { toolCallId: 'tc-1', messages: [] })

    expect(result.models.length).toBe(1)
    expect(result.invalidProviders.length).toBe(1)
    const bad = result.invalidProviders[0]
    expect(bad.id).toBe('p-bad')
    expect(bad.slug).toBe('bad')
    expect(bad.name).toBe('Bad Key')
    expect(bad.lastError).toBe('403 Forbidden')
  })

  it('explains a bad key in the note when only invalid providers exist', async () => {
    stubProviders([
      makeProviderRow({
        id: 'p-bad',
        isValid: false,
        lastError: '401 Unauthorized',
      }),
    ])

    const t = listModelsTool.create(makeCtx())
    const result = await (t as any).execute({}, { toolCallId: 'tc-1', messages: [] })

    expect(result.models).toEqual([])
    expect(result.invalidProviders.length).toBe(1)
    expect(result.note).toContain('currently failing')
    expect(result.note).toContain('re-test')
  })

  it('returns a plain note (no invalid hint) when no providers exist at all', async () => {
    stubProviders([])

    const t = listModelsTool.create(makeCtx())
    const result = await (t as any).execute({}, { toolCallId: 'tc-1', messages: [] })

    expect(result.models).toEqual([])
    expect(result.invalidProviders).toEqual([])
    expect(result.note).toContain('No models found')
    expect(result.note).not.toContain('currently failing')
  })
})
