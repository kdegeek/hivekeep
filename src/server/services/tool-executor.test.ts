import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { toolRegistry } from '@/server/tools/index'
import { partitionToolCalls, executeSingleTool, type ToolCall } from '@/server/services/tool-executor'
import type { ToolRegistration } from '@/server/tools/types'
import type { Tool } from '@/server/tools/tool-helper'

const fakeTool = (overrides: Partial<ToolRegistration> = {}): ToolRegistration => ({
  availability: ['main', 'sub-agent'],
  create: () => ({ description: '', inputSchema: undefined as any, execute: async () => null } as unknown as Tool<any, any>),
  ...overrides,
})

const NAMES = {
  read1: '__partition_test_read_1__',
  read2: '__partition_test_read_2__',
  read3: '__partition_test_read_3__',
  write: '__partition_test_write__',
  ambiguous: '__partition_test_ambiguous__',
}

const call = (name: string, id: string): ToolCall => ({ id, name, args: {}, offset: 0 })

describe('partitionToolCalls', () => {
  beforeAll(() => {
    toolRegistry.register(NAMES.read1, fakeTool({ readOnly: true, concurrencySafe: true }), 'system')
    toolRegistry.register(NAMES.read2, fakeTool({ readOnly: true, concurrencySafe: true }), 'system')
    toolRegistry.register(NAMES.read3, fakeTool({ readOnly: true, concurrencySafe: true }), 'system')
    toolRegistry.register(NAMES.write, fakeTool({}), 'system') // conservative default: write/unsafe
    toolRegistry.register(NAMES.ambiguous, fakeTool({ readOnly: true }), 'system') // readOnly but not concurrencySafe
  })

  afterAll(() => {
    for (const n of Object.values(NAMES)) toolRegistry.unregister(n)
  })

  it('fuses three consecutive read-only tools into one parallel batch', () => {
    const batches = partitionToolCalls([
      call(NAMES.read1, 'a'),
      call(NAMES.read2, 'b'),
      call(NAMES.read3, 'c'),
    ])
    expect(batches).toHaveLength(1)
    expect(batches[0]!.isConcurrencySafe).toBe(true)
    expect(batches[0]!.calls.map(c => c.id)).toEqual(['a', 'b', 'c'])
  })

  it('isolates a single write into its own serial batch', () => {
    const batches = partitionToolCalls([call(NAMES.write, 'w')])
    expect(batches).toHaveLength(1)
    expect(batches[0]!.isConcurrencySafe).toBe(false)
    expect(batches[0]!.calls).toHaveLength(1)
  })

  it('splits [read, read, write, read, write] into four batches', () => {
    const batches = partitionToolCalls([
      call(NAMES.read1, '1'),
      call(NAMES.read2, '2'),
      call(NAMES.write, '3'),
      call(NAMES.read1, '4'),
      call(NAMES.write, '5'),
    ])
    expect(batches).toHaveLength(4)
    expect(batches[0]!.isConcurrencySafe).toBe(true)
    expect(batches[0]!.calls.map(c => c.id)).toEqual(['1', '2'])
    expect(batches[1]!.isConcurrencySafe).toBe(false)
    expect(batches[1]!.calls.map(c => c.id)).toEqual(['3'])
    expect(batches[2]!.isConcurrencySafe).toBe(true)
    expect(batches[2]!.calls.map(c => c.id)).toEqual(['4'])
    expect(batches[3]!.isConcurrencySafe).toBe(false)
    expect(batches[3]!.calls.map(c => c.id)).toEqual(['5'])
  })

  it('treats unknown tools as conservative (serial, isolated)', () => {
    const batches = partitionToolCalls([
      call(NAMES.read1, 'a'),
      call('__unregistered_tool_name__', 'b'),
      call(NAMES.read2, 'c'),
    ])
    expect(batches).toHaveLength(3)
    expect(batches[0]!.isConcurrencySafe).toBe(true)
    expect(batches[1]!.isConcurrencySafe).toBe(false)
    expect(batches[2]!.isConcurrencySafe).toBe(true)
  })

  it('treats readOnly-without-concurrencySafe as serial (conservative)', () => {
    const batches = partitionToolCalls([
      call(NAMES.read1, 'a'),
      call(NAMES.ambiguous, 'b'),
      call(NAMES.read2, 'c'),
    ])
    expect(batches).toHaveLength(3)
    expect(batches[0]!.isConcurrencySafe).toBe(true)
    expect(batches[1]!.isConcurrencySafe).toBe(false)
    expect(batches[2]!.isConcurrencySafe).toBe(true)
  })

  it('returns an empty array for no calls', () => {
    expect(partitionToolCalls([])).toEqual([])
  })
})

describe('executeSingleTool — unavailable tool classification', () => {
  // The `tools` map passed in is the already-resolved (granted-only) toolset.
  // A name absent from it must produce a clear, classified message — never the
  // old cryptic "has no execute function".
  const NATIVE_NAME = '__exec_test_native__'
  const emptyTools: Record<string, Tool<any, any>> = {}
  const run = (name: string) =>
    executeSingleTool({ id: 'x', name, args: {}, offset: 0 }, emptyTools, new AbortController())

  beforeAll(() => {
    // Register a native tool in the in-memory registry so getDomain() != null,
    // but deliberately keep it OUT of the empty `tools` map passed to
    // executeSingleTool (simulating a registered-but-not-granted tool).
    toolRegistry.register(NATIVE_NAME, fakeTool({ readOnly: true, concurrencySafe: true }), 'system')
  })

  afterAll(() => {
    toolRegistry.unregister(NATIVE_NAME)
  })

  it('reports an unknown made-up name as non-existent', async () => {
    const result = (await run('totally_made_up')) as { error: string }
    expect(result.error).toContain('No tool named')
    expect(result.error).not.toContain('has no execute function')
  })

  it('reports a custom_<slug> with no DB row as non-existent', async () => {
    // Random slug that will not exist in the DB → deterministic "No tool named".
    const slug = `nope_${Math.random().toString(36).slice(2)}`
    const result = (await run(`custom_${slug}`)) as { error: string }
    expect(result.error).toContain('No tool named')
    expect(result.error).not.toContain('has no execute function')
  })

  it('reports an MCP tool name as not in the current toolset', async () => {
    const result = (await run('mcp_someserver_dothing')) as { error: string }
    expect(result.error).toContain('MCP tool')
    expect(result.error).toContain('not in your current toolset')
  })

  it('reports a registered native tool absent from the toolset as exists-but-not-granted', async () => {
    // NATIVE_NAME is registered in the in-memory registry by this suite, but is
    // NOT present in the empty `tools` map passed to executeSingleTool.
    const result = (await run(NATIVE_NAME)) as { error: string }
    expect(result.error).toContain('exists but is not in your current toolset')
  })

  it('reports a granted tool with no execute as misconfigured (internal bug)', async () => {
    const broken = { description: '', inputSchema: undefined } as unknown as Tool<any, any>
    const result = (await executeSingleTool(
      { id: 'x', name: 'broken_tool', args: {}, offset: 0 },
      { broken_tool: broken },
      new AbortController(),
    )) as { error: string }
    expect(result.error).toContain('misconfigured')
    expect(result.error).toContain('internal bug')
  })
})

describe('executeSingleTool — abort race', () => {
  // A tool that NEVER settles and ignores its abortSignal — simulates a stuck
  // or genuinely long-running tool that doesn't honour cancellation.
  const hangingTool = (): Tool<any, any> =>
    ({ description: '', inputSchema: undefined as any, execute: () => new Promise(() => {}) } as unknown as Tool<any, any>)

  it('unwinds with an abort error when the signal fires mid-execution, even if the tool ignores it', async () => {
    const controller = new AbortController()
    const start = Date.now()
    const p = executeSingleTool({ id: 'x', name: 'hang', args: {}, offset: 0 }, { hang: hangingTool() }, controller)
    setTimeout(() => controller.abort(), 100)
    const result = (await p) as { error: string }
    expect(result.error).toContain('aborted')
    expect(Date.now() - start).toBeLessThan(3000)
  })

  it('returns an abort error immediately when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = (await executeSingleTool(
      { id: 'x', name: 'hang', args: {}, offset: 0 },
      { hang: hangingTool() },
      controller,
    )) as { error: string }
    expect(result.error).toContain('aborted')
  })
})
