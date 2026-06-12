import { describe, it, expect, mock, beforeEach } from 'bun:test'
import type { ToolExecutionContext } from '@/server/tools/types'

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockCreateCustomTool = mock((p: any) =>
  Promise.resolve({ slug: p.slug, name: p.name, entrypoint: p.entrypoint }),
)
const mockWriteCustomToolFile = mock(() => Promise.resolve())
const mockRunToolSetup = mock(() => Promise.resolve({ success: true, output: 'ok' }))
const mockExecuteCustomTool = mock(() =>
  Promise.resolve({ success: true, output: 'hello', exitCode: 0, executionTime: 5 }),
)
const mockUpdateCustomTool = mock((slug: string) => ({ slug, enabled: true }))
const mockDeleteCustomTool = mock(() => Promise.resolve(true))
const mockListCustomTools = mock(() => [
  {
    slug: 'scrape',
    name: 'Scrape',
    description: 'Scrape a URL',
    domainSlug: 'custom',
    entrypoint: 'main.py',
    language: 'python',
    enabled: true,
    parameters: '{}',
  },
])

const mockCreateToolDomain = mock((p: any) => ({ slug: p.slug }))
const mockListToolDomains = mock(() => [{ slug: 'custom', builtin: true }])
const mockUpdateToolDomain = mock((slug: string) => ({ slug }))
const mockDeleteToolDomain = mock(() => {})

mock.module('@/server/services/custom-tools', () => ({
  createCustomTool: mockCreateCustomTool,
  writeCustomToolFile: mockWriteCustomToolFile,
  runToolSetup: mockRunToolSetup,
  executeCustomTool: mockExecuteCustomTool,
  updateCustomTool: mockUpdateCustomTool,
  deleteCustomTool: mockDeleteCustomTool,
  listCustomTools: mockListCustomTools,
  getCustomTool: mock(() => undefined),
}))

mock.module('@/server/services/tool-domains', () => ({
  createToolDomain: mockCreateToolDomain,
  listToolDomains: mockListToolDomains,
  updateToolDomain: mockUpdateToolDomain,
  deleteToolDomain: mockDeleteToolDomain,
}))

// Stub the renderer service so test_custom_tool's renderer-validation branch is
// deterministic and these unit tests don't pull in react-dom/server + the UI kit.
const mockCustomToolHasRenderer = mock(() => false)
const mockValidateCustomToolRenderer = mock(() => Promise.resolve({ ok: true }))
mock.module('@/server/services/custom-tool-renderer', () => ({
  customToolHasRenderer: mockCustomToolHasRenderer,
  validateCustomToolRenderer: mockValidateCustomToolRenderer,
}))

mock.module('@/server/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}))

// ─── Import after mocks ─────────────────────────────────────────────────────

const {
  createCustomToolTool,
  writeCustomToolFileTool,
  runCustomToolSetupTool,
  testCustomToolTool,
  updateCustomToolTool,
  deleteCustomToolTool,
  listCustomToolsTool,
  createToolDomainTool,
  listToolDomainsTool,
  updateToolDomainTool,
  deleteToolDomainTool,
} = await import('@/server/tools/custom-tool-tools')

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ctx: ToolExecutionContext = { agentId: 'agent-abc', isSubAgent: false }

function execute(registration: any, args: any) {
  const t = registration.create(ctx)
  return t.execute(args, { toolCallId: 'tc-1', messages: [], abortSignal: new AbortController().signal })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('custom-tool-tools (global)', () => {
  beforeEach(() => {
    mockCreateCustomTool.mockClear()
    mockWriteCustomToolFile.mockClear()
    mockExecuteCustomTool.mockClear()
    mockListCustomTools.mockClear()
    mockCreateToolDomain.mockClear()
  })

  it('all authoring/admin tools are main-only', () => {
    for (const reg of [
      createCustomToolTool,
      writeCustomToolFileTool,
      runCustomToolSetupTool,
      testCustomToolTool,
      updateCustomToolTool,
      deleteCustomToolTool,
      listCustomToolsTool,
      createToolDomainTool,
      listToolDomainsTool,
      updateToolDomainTool,
      deleteToolDomainTool,
    ]) {
      expect(reg.availability).toEqual(['main'])
    }
  })

  describe('create_custom_tool', () => {
    it('creates a tool (createdBy agent) and writes code when provided', async () => {
      const result = await execute(createCustomToolTool, {
        slug: 'scrape',
        name: 'Scrape',
        description: 'Scrape a URL',
        parameters: '{"type":"object","properties":{"url":{"type":"string"}}}',
        language: 'python',
        code: 'print("hi")',
      })
      expect(result.success).toBe(true)
      expect(result.toolName).toBe('custom_scrape')
      expect(mockCreateCustomTool).toHaveBeenCalled()
      const arg = (mockCreateCustomTool.mock.calls[0]?.[0] ?? {}) as any
      expect(arg.createdBy).toBe('agent')
      expect(arg.entrypoint).toBe('main.py') // default for python
      expect(mockWriteCustomToolFile).toHaveBeenCalledWith('scrape', 'main.py', 'print("hi")')
    })

    it('returns error on failure', async () => {
      mockCreateCustomTool.mockImplementationOnce(() => Promise.reject(new Error('slug taken')))
      const result = await execute(createCustomToolTool, {
        slug: 'dup',
        name: 'x',
        description: 'y',
        parameters: '{}',
      })
      expect(result.error).toBe('slug taken')
    })
  })

  describe('test_custom_tool', () => {
    beforeEach(() => {
      mockCustomToolHasRenderer.mockClear()
      mockValidateCustomToolRenderer.mockClear()
      mockCustomToolHasRenderer.mockImplementation(() => false)
      mockValidateCustomToolRenderer.mockImplementation(() => Promise.resolve({ ok: true }))
    })

    it('executes by slug', async () => {
      const result = await execute(testCustomToolTool, { slug: 'scrape', args: { url: 'x' } })
      expect(result.success).toBe(true)
      expect(mockExecuteCustomTool).toHaveBeenCalledWith('scrape', { url: 'x' }, undefined)
    })

    it('omits the renderer field when the tool ships no renderer', async () => {
      mockCustomToolHasRenderer.mockImplementation(() => false)
      const result = await execute(testCustomToolTool, { slug: 'scrape' })
      expect(result.renderer).toBeUndefined()
      expect(mockValidateCustomToolRenderer).not.toHaveBeenCalled()
    })

    it('includes the renderer validation result when a renderer exists', async () => {
      mockCustomToolHasRenderer.mockImplementation(() => true)
      mockValidateCustomToolRenderer.mockImplementation(() =>
        Promise.resolve({ ok: false, phase: 'render', error: 'boom' }),
      )
      const result = await execute(testCustomToolTool, { slug: 'scrape', args: { url: 'x' } })
      expect(result.success).toBe(true) // execution output preserved
      expect(result.renderer).toEqual({ ok: false, phase: 'render', error: 'boom' })
      expect(mockValidateCustomToolRenderer).toHaveBeenCalledWith('scrape', expect.anything(), { url: 'x' })
    })

    it('does not fail the test when the validator throws internally', async () => {
      mockCustomToolHasRenderer.mockImplementation(() => true)
      mockValidateCustomToolRenderer.mockImplementation(() => Promise.reject(new Error('validator exploded')))
      const result = await execute(testCustomToolTool, { slug: 'scrape' })
      expect(result.success).toBe(true)
      expect(result.renderer).toEqual({ ok: false, error: 'validator exploded' })
    })
  })

  describe('list_custom_tools', () => {
    it('maps fields including custom_<slug> tool name', async () => {
      const result = await execute(listCustomToolsTool, {})
      expect(result.tools).toHaveLength(1)
      expect(result.tools[0].toolName).toBe('custom_scrape')
      expect(result.tools[0].slug).toBe('scrape')
      expect(result.tools[0].enabled).toBe(true)
    })
  })

  describe('create_tool_domain', () => {
    it('creates a custom domain', async () => {
      const result = await execute(createToolDomainTool, {
        slug: 'weather',
        label: 'Weather',
        icon: 'CloudSun',
        color: 'chart-3',
      })
      expect(result.success).toBe(true)
      expect(mockCreateToolDomain).toHaveBeenCalled()
    })
  })
})
