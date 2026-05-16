import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { toolRegistry } from '@/server/tools/index'
import { partitionToolCalls, type ToolCall } from '@/server/services/tool-executor'
import type { ToolRegistration } from '@/server/tools/types'
import type { Tool } from 'ai'

const fakeTool = (overrides: Partial<ToolRegistration> = {}): ToolRegistration => ({
  availability: ['main', 'sub-kin'],
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
