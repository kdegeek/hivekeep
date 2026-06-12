import { describe, it, expect } from 'bun:test'
import { buildSegmentedMessages } from '@/server/services/llm-cache-hints'
import type {
  HivekeepMessage,
  HivekeepMessageBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
} from '@/server/llm/llm/types'

function findCachedBlock(msg: HivekeepMessage): HivekeepMessageBlock | undefined {
  return msg.content.find((b) => (b as { cacheControl?: unknown }).cacheControl !== undefined)
}

function hasCacheHint(msg: HivekeepMessage): boolean {
  return findCachedBlock(msg) !== undefined
}

function textOf(msg: HivekeepMessage): string {
  return msg.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

describe('buildSegmentedMessages', () => {
  it('emits only the stable system block when history is empty', () => {
    const out = buildSegmentedMessages(
      { stable: 'STABLE', volatile: 'VOLATILE' },
      [],
    )
    expect(out.messages).toEqual([])
    expect(out.system).toBeDefined()
    expect(out.system).toHaveLength(1)
    expect(out.system![0]).toMatchObject({
      type: 'text',
      text: 'STABLE',
      cacheControl: { type: 'ephemeral' },
    })
    // Volatile must NEVER appear as a separate system block — that would
    // split the cacheable prefix and prevent history caching across turns.
    expect(out.system!.some((b) => b.text === 'VOLATILE')).toBe(false)
  })

  it('multi-turn history: places cross-turn breakpoint before new user msg, within-turn breakpoint on last', () => {
    const history: HivekeepMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'turn 1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply 1' }] },
      { role: 'user', content: [{ type: 'text', text: 'turn 2' }] },
    ]
    const out = buildSegmentedMessages(
      { stable: 'STABLE', volatile: 'VOLATILE' },
      history,
    )
    // [stable system, user1, asst1, user2-with-volatile]
    expect(out.system).toHaveLength(1)
    expect(out.system![0]!.cacheControl).toEqual({ type: 'ephemeral' })
    expect(out.messages).toHaveLength(3)
    // user1 has no breakpoint
    expect(hasCacheHint(out.messages[0]!)).toBe(false)
    expect(textOf(out.messages[0]!)).toBe('turn 1')
    // asst1 = the message immediately before the new user msg → cross-turn cache breakpoint
    expect(hasCacheHint(out.messages[1]!)).toBe(true)
    expect(textOf(out.messages[1]!)).toBe('reply 1')
    // user2 = the new user message, has volatile prepended as <system-reminder>
    expect(textOf(out.messages[2]!)).toContain('<system-reminder>')
    expect(textOf(out.messages[2]!)).toContain('VOLATILE')
    expect(textOf(out.messages[2]!)).toContain('turn 2')
    // It also gets a cache breakpoint (within-turn step caching anchor)
    expect(hasCacheHint(out.messages[2]!)).toBe(true)
  })

  it('mid tool-loop: cross-turn breakpoint stays anchored on pre-user-msg position', () => {
    // Simulates a request mid-way through a tool loop: the new user message
    // is in the middle of history, followed by assistant + tool messages.
    const history: HivekeepMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'turn 1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply 1' }] },
      { role: 'user', content: [{ type: 'text', text: 'turn 2' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool-use', id: 't1', name: 'foo', args: {} } as ToolUseBlock],
      },
      {
        role: 'user',
        content: [{ type: 'tool-result', toolUseId: 't1', content: 'ok' } as ToolResultBlock],
      },
    ]
    const out = buildSegmentedMessages(
      { stable: 'STABLE', volatile: 'VOLATILE' },
      history,
    )
    expect(out.messages).toHaveLength(5)
    // Cross-turn breakpoint on asst1 (just before user2 = the new user msg)
    expect(hasCacheHint(out.messages[1]!)).toBe(true)
    // user2 has volatile prepended
    expect(textOf(out.messages[2]!)).toContain('VOLATILE')
    // user2 itself has no breakpoint (BP_LAST is on the final tool result)
    expect(hasCacheHint(out.messages[2]!)).toBe(false)
    // asst-toolcall has no breakpoint
    expect(hasCacheHint(out.messages[3]!)).toBe(false)
    // Final tool-result message has the within-turn breakpoint — anchored
    // on the tool-result block itself (no text block available)
    const lastCached = findCachedBlock(out.messages[4]!)
    expect(lastCached).toBeDefined()
    expect(lastCached!.type).toBe('tool-result')
  })

  it('handles missing volatile segment (no <system-reminder> injected)', () => {
    const out = buildSegmentedMessages(
      { stable: 'STABLE', volatile: '' },
      [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    )
    expect(out.system).toHaveLength(1)
    expect(out.messages).toHaveLength(1)
    expect(textOf(out.messages[0]!)).toBe('hello')
    expect(textOf(out.messages[0]!)).not.toContain('<system-reminder>')
    // Single-message history: BP3 not applied (no preceding message),
    // BP4 also skipped (degenerate case — lastIdx === 0). Stable system
    // segment carries the only breakpoint.
    expect(hasCacheHint(out.messages[0]!)).toBe(false)
  })

  it('cache hint anchors on the LAST non-empty text block of a message', () => {
    const history: HivekeepMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'previous reply' },
          { type: 'text', text: 'and another paragraph' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'last message' }] },
    ]
    const out = buildSegmentedMessages({ stable: 'STABLE', volatile: '' }, history)
    expect(out.messages).toHaveLength(2)
    // Cross-turn anchor on the previous assistant — placed on the LAST
    // text block, not the first.
    const cached = findCachedBlock(out.messages[0]!)
    expect(cached).toBeDefined()
    expect(cached!.type).toBe('text')
    expect((cached as TextBlock).text).toBe('and another paragraph')
    // First text block left untouched
    expect((out.messages[0]!.content[0] as TextBlock).cacheControl).toBeUndefined()
  })

  it('skips empty-text-only message as cross-turn anchor (Anthropic rejects cache_control on empty text blocks)', () => {
    // Reproduces the sub-Agent resume failure after request_input: an assistant
    // row with content=[{text: ''}] sat between the original user message
    // and the human-response user message. The natural anchor (idx 1) is
    // empty, so cache_control must walk back to a prior carriable message.
    const history: HivekeepMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'do the task' }] },
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
      { role: 'user', content: [{ type: 'text', text: '[Human response]: yes' }] },
    ]
    const out = buildSegmentedMessages({ stable: 'STABLE', volatile: '' }, history)
    expect(out.messages).toHaveLength(3)
    // Empty assistant must NOT carry cache_control
    expect(hasCacheHint(out.messages[1]!)).toBe(false)
    // Anchor walks back to the prior user message instead
    expect(hasCacheHint(out.messages[0]!)).toBe(true)
  })

  it('skips a single-empty-text content array as the last-message anchor', () => {
    // Same hazard but on BP_LAST: if the final message is a single empty
    // text block, we must not attach cache_control there either.
    const history: HivekeepMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
    ]
    const out = buildSegmentedMessages({ stable: 'STABLE', volatile: '' }, history)
    expect(out.messages).toHaveLength(2)
    expect(hasCacheHint(out.messages[1]!)).toBe(false)
  })

  it('volatile is wrapped in <system-reminder> tags exactly', () => {
    const out = buildSegmentedMessages(
      { stable: 'STABLE', volatile: 'memories: foo, date: bar' },
      [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    )
    const userMsg = out.messages[0]!
    // First block is the system-reminder
    expect(userMsg.content[0]).toMatchObject({
      type: 'text',
      text: '<system-reminder>\nmemories: foo, date: bar\n</system-reminder>',
    })
    // Original content preserved after
    expect(userMsg.content[1]).toMatchObject({ type: 'text', text: 'hello' })
  })

  it('stable system segment is omitted when empty', () => {
    const out = buildSegmentedMessages(
      { stable: '', volatile: '' },
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    )
    expect(out.system).toBeUndefined()
    expect(out.messages).toHaveLength(1)
  })

  it('anchors BP4 on a tool-result block when last message has no text', () => {
    // Multi-step tool loop: last message of step N is a tool-result-only
    // user turn. cache_control must land on the tool-result block since
    // there is no text block to anchor it on.
    const history: HivekeepMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool-use', id: 't1', name: 'foo', args: {} } as ToolUseBlock],
      },
      {
        role: 'user',
        content: [{ type: 'tool-result', toolUseId: 't1', content: 'done' } as ToolResultBlock],
      },
    ]
    const out = buildSegmentedMessages({ stable: 'STABLE', volatile: '' }, history)
    expect(out.messages).toHaveLength(3)
    const cached = findCachedBlock(out.messages[2]!)
    expect(cached).toBeDefined()
    expect(cached!.type).toBe('tool-result')
  })
})
