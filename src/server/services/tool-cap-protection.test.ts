import { describe, it, expect } from 'bun:test'
import { tool } from '@/server/tools/tool-helper'
import { __testCapTools } from '@/server/services/agent-engine'

function fakeTools(names: string[]) {
  return Object.fromEntries(
    names.map((name) => [
      name,
      tool({
        description: name,
        inputSchema: undefined as any,
        execute: async () => null,
      }),
    ]),
  )
}

describe('agent-engine tool cap protection', () => {
  it('keeps restart_platform when a broad toolset exceeds the provider cap', () => {
    const names = [
      'read_file',
      'write_file',
      ...Array.from({ length: 130 }, (_, i) => `zz_droppable_${i}`),
      'restart_platform',
    ]

    const capped = __testCapTools(
      fakeTools(names),
      'agent-1',
      'test-provider',
      { maxTools: 128 },
    )

    expect(Object.keys(capped)).toHaveLength(128)
    expect(capped.restart_platform).toBeDefined()
    expect(capped.read_file).toBeDefined()
    expect(capped.write_file).toBeDefined()
  })
})
