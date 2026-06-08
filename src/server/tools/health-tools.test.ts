import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test'
import { fullMockConfig } from '../../test-helpers'
import type { ToolExecutionContext } from '@/server/tools/types'

// ─── Mocks ───────────────────────────────────────────────────────────────────
//
// Same discipline as provider-tools.test.ts: bun's `mock.module` poisons the
// underlying binding globally and persists across files, so we (1) spread the
// REAL module so other suites that re-import it for real keep their exports, and
// (2) restore everything in afterAll. We mock the LEAF `encryption` dependency
// (identity) — exactly as provider-config.test.ts does — so the real
// `loadProviderConfig` runs harmlessly against synthetic rows, and we mock
// `listModelsForProvider` so no upstream provider API is ever hit.

const _realDbIndex = await import('@/server/db/index')
const _realDbSchema = await import('@/server/db/schema')
const _realProvidersIndex = await import('@/server/providers/index')
const _realEncryption = await import('@/server/services/encryption')
const _realAppSettings = await import('@/server/services/app-settings')
const _realConfig = await import('@/server/config')
const _realLogger = await import('@/server/logger')

// db.select().from(table).all() — each execute() call queues providers then
// channels via mockReturnValueOnce(), mirroring provider-tools.test.ts.
const mockDbSelect = mock(() => ({
  from: mock(() => ({ all: mock(() => Promise.resolve([] as unknown[])) })),
}))

mock.module('@/server/db/index', () => ({
  ..._realDbIndex,
  db: { select: mockDbSelect },
}))

mock.module('@/server/db/schema', () => ({
  ..._realDbSchema,
  providers: {},
  channels: {},
}))

// By default every valid provider lists this one model. Tests override per-case.
const mockListModelsForProvider = mock(() =>
  Promise.resolve([{ id: 'gpt-4o', name: 'GPT-4o', capability: 'llm' as const }]),
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

// App-settings default getters. Mutable so each test can dictate the defaults.
const defaults: Record<string, string | null> = {}
function getDefault(key: string) {
  return Promise.resolve(defaults[key] ?? null)
}
mock.module('@/server/services/app-settings', () => ({
  ..._realAppSettings,
  getDefaultLlmModel: () => getDefault('llmModel'),
  getDefaultLlmProviderId: () => getDefault('llmProviderId'),
  getEmbeddingModel: () => getDefault('embeddingModel'),
  getEmbeddingProviderId: () => getDefault('embeddingProviderId'),
  getDefaultImageModel: () => getDefault('imageModel'),
  getDefaultImageProviderId: () => getDefault('imageProviderId'),
  getDefaultScoutModel: () => getDefault('scoutModel'),
  getDefaultScoutProviderId: () => getDefault('scoutProviderId'),
  getDefaultCompactingModel: () => getDefault('compactingModel'),
  getDefaultCompactingProviderId: () => getDefault('compactingProviderId'),
  getExtractionModel: () => getDefault('extractionModel'),
  getExtractionProviderId: () => getDefault('extractionProviderId'),
  getDefaultSearchProviderId: () => getDefault('searchProviderId'),
  getDefaultTtsProviderId: () => getDefault('ttsProviderId'),
  getDefaultSttProviderId: () => getDefault('sttProviderId'),
}))

// Mutable config so we can flip publicUrl / installationType per test.
const mockConfig: Record<string, unknown> = { ...fullMockConfig }
mock.module('@/server/config', () => ({ config: mockConfig }))

mock.module('@/server/logger', () => ({
  ..._realLogger,
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}))

afterAll(() => {
  mock.module('@/server/db/index', () => ({ ..._realDbIndex }))
  mock.module('@/server/db/schema', () => ({ ..._realDbSchema }))
  mock.module('@/server/providers/index', () => ({ ..._realProvidersIndex }))
  mock.module('@/server/services/encryption', () => ({ ..._realEncryption }))
  mock.module('@/server/services/app-settings', () => ({ ..._realAppSettings }))
  mock.module('@/server/config', () => ({ ..._realConfig }))
  mock.module('@/server/logger', () => ({ ..._realLogger }))
})

// Import after mocks.
const { getSetupHealthTool } = await import('@/server/tools/health-tools')

// ─── Helpers ─────────────────────────────────────────────────────────────────

const makeCtx = (overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
  agentId: 'agent-test-1',
  userId: 'user-1',
  isSubAgent: false,
  ...overrides,
})

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

function makeChannelRow(opts: {
  id?: string
  name?: string
  platform?: string
  status?: string
  statusMessage?: string | null
} = {}) {
  return {
    id: opts.id ?? 'c-1',
    name: opts.name ?? 'My Telegram',
    platform: opts.platform ?? 'telegram',
    status: opts.status ?? 'active',
    statusMessage: opts.statusMessage ?? null,
  }
}

/** Queue the two `db.select().from().all()` reads the tool performs, in order:
 *  first providers, then channels. */
function stubRows(providerRows: unknown[], channelRows: unknown[] = []) {
  mockDbSelect
    .mockReturnValueOnce({ from: mock(() => ({ all: mock(() => Promise.resolve(providerRows)) })) } as any)
    .mockReturnValueOnce({ from: mock(() => ({ all: mock(() => Promise.resolve(channelRows)) })) } as any)
}

function run() {
  const t = getSetupHealthTool.create(makeCtx())
  return (t as any).execute({}, { toolCallId: 'tc-1', messages: [] })
}

beforeEach(() => {
  for (const k of Object.keys(defaults)) delete defaults[k]
  Object.assign(mockConfig, fullMockConfig)
  mockListModelsForProvider.mockReset()
  mockListModelsForProvider.mockResolvedValue([
    { id: 'gpt-4o', name: 'GPT-4o', capability: 'llm' as const },
  ] as any)
})

// ─── Registration shape ────────────────────────────────────────────────────────

describe('getSetupHealthTool registration', () => {
  it('is read-only and concurrency-safe, available to main + sub-agent', () => {
    expect(getSetupHealthTool.readOnly).toBe(true)
    expect(getSetupHealthTool.concurrencySafe).toBe(true)
    expect(getSetupHealthTool.availability).toEqual(['main', 'sub-agent'])
  })

  it('has a description that tells Queenie to call it first on a rescue', () => {
    const t = getSetupHealthTool.create(makeCtx())
    expect((t as any).description).toContain('HEALTH CHECK')
    expect((t as any).description.toUpperCase()).toContain('FIRST')
  })
})

// ─── Capability coverage ────────────────────────────────────────────────────────

describe('getSetupHealthTool capability coverage', () => {
  it('flags a missing LLM provider as critical', async () => {
    stubRows([])
    const result = await run()
    expect(result.capabilityCoverage.llm.hasValidProvider).toBe(false)
    const llmIssue = result.issues.find((i: any) => i.problem.includes('No VALID LLM'))
    expect(llmIssue).toBeDefined()
    expect(llmIssue.severity).toBe('critical')
    expect(result.healthy).toBe(false)
  })

  it('reports a covered LLM capability when a valid llm provider exists', async () => {
    stubRows([makeProviderRow({ capabilities: ['llm'] })])
    const result = await run()
    expect(result.capabilityCoverage.llm.hasValidProvider).toBe(true)
    expect(result.capabilityCoverage.llm.validProviders).toContain('openai')
    expect(result.issues.find((i: any) => i.problem.includes('No VALID LLM'))).toBeUndefined()
  })

  it('flags a missing embedding provider as a warning (keyword-only memory)', async () => {
    stubRows([makeProviderRow({ capabilities: ['llm'] })])
    const result = await run()
    const embIssue = result.issues.find((i: any) => i.problem.includes('keyword-only'))
    expect(embIssue).toBeDefined()
    expect(embIssue.severity).toBe('warning')
    expect(embIssue.fix).toContain('enable_provider_capability')
  })

  it('emits info-level nudges for missing image/search/tts/stt', async () => {
    stubRows([makeProviderRow({ capabilities: ['llm'] })])
    const result = await run()
    const infos = result.issues.filter((i: any) => i.severity === 'info').map((i: any) => i.problem)
    expect(infos.some((p: string) => p.includes('image'))).toBe(true)
    expect(infos.some((p: string) => p.includes('search'))).toBe(true)
    expect(infos.some((p: string) => p.toLowerCase().includes('text-to-speech'))).toBe(true)
    expect(infos.some((p: string) => p.toLowerCase().includes('speech-to-text'))).toBe(true)
  })
})

// ─── Invalid providers (bad key) ─────────────────────────────────────────────────

describe('getSetupHealthTool invalid providers', () => {
  it('surfaces an invalid provider with its lastError and a re-key fix', async () => {
    stubRows([
      makeProviderRow({
        id: 'p-bad', slug: 'bad', name: 'Bad Key',
        isValid: false, lastError: '401 Unauthorized: invalid api key', capabilities: ['llm'],
      }),
    ])
    const result = await run()
    expect(result.invalidProviders.length).toBe(1)
    expect(result.invalidProviders[0].lastError).toContain('401 Unauthorized')

    const keyIssue = result.issues.find((i: any) => i.problem.includes('Bad Key'))
    expect(keyIssue).toBeDefined()
    expect(keyIssue.severity).toBe('critical')
    expect(keyIssue.fix).toContain('request_provider_setup')
    expect(keyIssue.fix).toContain('test_provider')
  })
})

// ─── Stale / missing default models ──────────────────────────────────────────────

describe('getSetupHealthTool stale default detection', () => {
  it('flags a default model that the provider no longer lists', async () => {
    defaults.llmModel = 'gpt-3.5-turbo-DEPRECATED'
    defaults.llmProviderId = 'p-1'
    stubRows([makeProviderRow({ id: 'p-1', slug: 'openai', capabilities: ['llm'] })])
    // provider lists gpt-4o (default mock), NOT the deprecated id
    const result = await run()

    expect(result.defaultModels.llm.status).toBe('stale')
    const stale = result.issues.find((i: any) => i.problem.includes('NO LONGER listed'))
    expect(stale).toBeDefined()
    expect(stale.severity).toBe('critical')
    expect(stale.fix).toContain('set_default_model')
  })

  it('marks a default as ok when the model is still in the catalogue', async () => {
    defaults.llmModel = 'gpt-4o'
    defaults.llmProviderId = 'p-1'
    stubRows([makeProviderRow({ id: 'p-1', slug: 'openai', capabilities: ['llm'] })])
    const result = await run()
    expect(result.defaultModels.llm.status).toBe('ok')
    expect(result.issues.find((i: any) => i.problem.includes('NO LONGER listed'))).toBeUndefined()
  })

  it('flags a default model pinned to a provider that no longer exists', async () => {
    defaults.llmModel = 'gpt-4o'
    defaults.llmProviderId = 'p-ghost'
    stubRows([makeProviderRow({ id: 'p-1', slug: 'openai', capabilities: ['llm'] })])
    const result = await run()
    expect(result.defaultModels.llm.status).toBe('no-provider')
    const ghost = result.issues.find((i: any) => i.problem.includes('no longer exists'))
    expect(ghost).toBeDefined()
    expect(ghost.fix).toContain('set_default_model')
  })

  it('does not cry wolf when the catalogue cannot be listed (status unknown)', async () => {
    defaults.llmModel = 'some-model'
    defaults.llmProviderId = 'p-1'
    mockListModelsForProvider.mockResolvedValue([] as any) // empty catalogue
    stubRows([makeProviderRow({ id: 'p-1', slug: 'openai', capabilities: ['llm'] })])
    const result = await run()
    expect(result.defaultModels.llm.status).toBe('unknown')
    expect(result.issues.find((i: any) => i.problem.includes('NO LONGER listed'))).toBeUndefined()
  })
})

// ─── Channels ────────────────────────────────────────────────────────────────────

describe('getSetupHealthTool channels', () => {
  it('flags an inactive channel and points at test_channel', async () => {
    stubRows(
      [makeProviderRow({ capabilities: ['llm'] })],
      [makeChannelRow({ id: 'c-9', name: 'Telegram Bot', status: 'inactive' })],
    )
    const result = await run()
    expect(result.channels.length).toBe(1)
    const chIssue = result.issues.find((i: any) => i.problem.includes('Telegram Bot'))
    expect(chIssue).toBeDefined()
    expect(chIssue.fix).toContain('test_channel')
    expect(chIssue.fix).toContain('c-9')
  })

  it('flags an errored channel as a warning with its statusMessage', async () => {
    stubRows(
      [makeProviderRow({ capabilities: ['llm'] })],
      [makeChannelRow({ id: 'c-err', status: 'error', statusMessage: 'invalid bot token' })],
    )
    const result = await run()
    const chIssue = result.issues.find((i: any) => i.problem.includes('invalid bot token'))
    expect(chIssue).toBeDefined()
    expect(chIssue.severity).toBe('warning')
  })

  it('does not flag an active channel', async () => {
    stubRows(
      [makeProviderRow({ capabilities: ['llm'] })],
      [makeChannelRow({ status: 'active' })],
    )
    const result = await run()
    expect(result.issues.find((i: any) => i.fix?.includes('test_channel'))).toBeUndefined()
  })
})

// ─── Public URL sanity ───────────────────────────────────────────────────────────

describe('getSetupHealthTool public URL sanity', () => {
  it('warns when PUBLIC_URL is a localhost default on a non-manual install', async () => {
    mockConfig.publicUrl = 'http://localhost:3000'
    mockConfig.isDocker = true
    mockConfig.environment = { ...(fullMockConfig as any).environment, installationType: 'docker' }
    stubRows([makeProviderRow({ capabilities: ['llm'] })])
    const result = await run()
    expect(result.publicUrl.isLocalhostDefault).toBe(true)
    const urlIssue = result.issues.find((i: any) => i.problem.includes('PUBLIC_URL'))
    expect(urlIssue).toBeDefined()
    expect(urlIssue.severity).toBe('warning')
    expect(urlIssue.fix).toContain('PUBLIC_URL')
  })

  it('does not warn about a localhost PUBLIC_URL on a manual install', async () => {
    mockConfig.publicUrl = 'http://localhost:3000'
    mockConfig.environment = { ...(fullMockConfig as any).environment, installationType: 'manual' }
    stubRows([makeProviderRow({ capabilities: ['llm'] })])
    const result = await run()
    expect(result.issues.find((i: any) => i.problem.includes('PUBLIC_URL'))).toBeUndefined()
  })

  it('does not warn when PUBLIC_URL is a real host', async () => {
    mockConfig.publicUrl = 'https://hivekeep.example.com'
    mockConfig.isDocker = true
    mockConfig.environment = { ...(fullMockConfig as any).environment, installationType: 'docker' }
    stubRows([makeProviderRow({ capabilities: ['llm'] })])
    const result = await run()
    expect(result.publicUrl.isLocalhostDefault).toBe(false)
    expect(result.issues.find((i: any) => i.problem.includes('PUBLIC_URL'))).toBeUndefined()
  })
})

// ─── Overall + ordering ──────────────────────────────────────────────────────────

describe('getSetupHealthTool summary + ordering', () => {
  it('reports healthy when LLM + embedding are valid and no other warnings', async () => {
    defaults.llmModel = 'gpt-4o'
    defaults.llmProviderId = 'p-1'
    defaults.embeddingModel = 'text-embedding-3-small'
    defaults.embeddingProviderId = 'p-1'
    defaults.imageProviderId = 'p-1'
    defaults.imageModel = 'gpt-4o'
    defaults.searchProviderId = 'p-1'
    defaults.ttsProviderId = 'p-1'
    defaults.sttProviderId = 'p-1'
    // One provider covering every capability; lists the embedding + image ids too.
    ;(mockListModelsForProvider as any).mockImplementation((_type: string, _cfg: unknown, family: string) => {
      if (family === 'embedding') return Promise.resolve([{ id: 'text-embedding-3-small', name: 'emb', capability: 'embedding' }] as any)
      return Promise.resolve([{ id: 'gpt-4o', name: 'GPT-4o', capability: family }] as any)
    })
    stubRows([
      makeProviderRow({ id: 'p-1', slug: 'openai', capabilities: ['llm', 'embedding', 'image', 'search', 'tts', 'stt'] }),
    ])
    const result = await run()
    expect(result.counts.critical).toBe(0)
    expect(result.counts.warning).toBe(0)
    expect(result.healthy).toBe(true)
    expect(result.summary).toContain('No problems')
  })

  it('sorts issues by severity (critical before warning before info)', async () => {
    // No providers at all → critical (no LLM) + warning (no embedding) + infos.
    stubRows([])
    const result = await run()
    const order = { critical: 0, warning: 1, info: 2 } as Record<string, number>
    const ranks = result.issues.map((i: any) => order[i.severity])
    const sorted = [...ranks].sort((a, b) => a - b)
    expect(ranks).toEqual(sorted)
    expect(result.counts.critical).toBeGreaterThanOrEqual(1)
  })
})
