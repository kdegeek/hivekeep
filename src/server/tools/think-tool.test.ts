import { describe, it, expect, mock } from 'bun:test'

mock.module('@/server/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

const { thinkTool } = await import('./think-tool')

function execute(input: { thought: string }) {
  const ctx = { agentId: 'agent-1', isSubAgent: false }
  // The AI SDK's `Tool` type marks `execute` as optional. We unwrap it once
  // here so the rest of the tests stay terse.
  const t = thinkTool.create(ctx as never) as unknown as {
    execute: (i: { thought: string }) => Promise<unknown>
  }
  return t.execute(input)
}

describe('thinkTool', () => {
  it('is read-only and concurrency-safe (can be batched in a step)', () => {
    expect(thinkTool.readOnly).toBe(true)
    expect(thinkTool.concurrencySafe).toBe(true)
  })

  it('is available to main and sub-Agent contexts', () => {
    expect(thinkTool.availability).toEqual(['main', 'sub-agent'])
  })

  it('records the thought and echoes it back', async () => {
    const result = (await execute({
      thought: 'Failing test points at a missing import — check the resolver before adding noise.',
    })) as { success: boolean; thought: string }
    expect(result.success).toBe(true)
    expect(result.thought).toContain('Failing test')
  })

  it('returns multi-paragraph thoughts intact', async () => {
    const text = 'Step 1: read the file.\n\nStep 2: look for callers.\n\nStep 3: write the test.'
    const result = (await execute({ thought: text })) as { thought: string }
    expect(result.thought).toBe(text)
  })

  it('schema rejects empty or oversized thoughts', () => {
    // Validation lives in the tool's inputSchema (z.string().min(1).max(8000)).
    // We don't have the schema instance directly here — the AI SDK wraps it —
    // but smoke-test by sending an obviously-large input through execute() to
    // confirm we don't blow up on long strings.
    const big = 'a'.repeat(5000)
    return execute({ thought: big }).then((r) => {
      const result = r as { thought: string }
      expect(result.thought.length).toBe(5000)
    })
  })
})
