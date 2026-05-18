import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { tool } from '@/server/tools/tool-helper'
import {
  vercelToolsToKinbot,
  markLastKinbotToolCacheable,
  splitSystemFromVercelMessages,
  modelMessagesToKinbot,
} from './vercel-bridge'
import type { KinbotTool } from '@/server/llm/llm/types'

// ─── vercelToolsToKinbot ─────────────────────────────────────────────────────

describe('vercelToolsToKinbot', () => {
  it('converts a tool with a zod inputSchema to a JSON schema', async () => {
    const tools = {
      read_file: tool({
        description: 'Read a file',
        inputSchema: z.object({
          path: z.string(),
          offset: z.number().optional(),
        }),
      }),
    }
    const result = await vercelToolsToKinbot(tools as never)
    expect(result).toHaveLength(1)
    const t0 = result[0]!
    expect(t0.name).toBe('read_file')
    expect(t0.description).toBe('Read a file')
    expect(t0.inputSchema.type).toBe('object')
    // properties must be present even for trivial schemas — OpenAI requires it.
    expect(t0.inputSchema.properties).toBeDefined()
    expect((t0.inputSchema.properties as Record<string, unknown>).path).toBeDefined()
  })

  it('forces type=object and empty properties when the schema is absent', async () => {
    // Some legacy tools may have a missing/empty inputSchema. The bridge
    // must still emit a payload OpenAI accepts.
    const tools = {
      noop: tool({
        description: 'No args',
        inputSchema: z.object({}),
      }),
    }
    const result = await vercelToolsToKinbot(tools as never)
    expect(result[0]!.inputSchema.type).toBe('object')
    expect('properties' in result[0]!.inputSchema).toBe(true)
  })

  it('extracts the description from each tool', async () => {
    const tools = {
      tool_a: tool({ description: 'first', inputSchema: z.object({}) }),
      tool_b: tool({ description: 'second', inputSchema: z.object({}) }),
    }
    const result = await vercelToolsToKinbot(tools as never)
    expect(result.map((t) => t.description)).toEqual(['first', 'second'])
  })
})

// ─── markLastKinbotToolCacheable ─────────────────────────────────────────────

describe('markLastKinbotToolCacheable', () => {
  it('adds cacheControl to the last tool only', () => {
    const tools: KinbotTool[] = [
      { name: 'a', description: 'A', inputSchema: { type: 'object' } },
      { name: 'b', description: 'B', inputSchema: { type: 'object' } },
      { name: 'c', description: 'C', inputSchema: { type: 'object' } },
    ]
    const out = markLastKinbotToolCacheable(tools)
    expect(out[0]!.cacheControl).toBeUndefined()
    expect(out[1]!.cacheControl).toBeUndefined()
    expect(out[2]!.cacheControl).toEqual({ type: 'ephemeral' })
  })

  it('returns the input unchanged when there are no tools', () => {
    const tools: KinbotTool[] = []
    expect(markLastKinbotToolCacheable(tools)).toEqual([])
  })

  it('is pure — does not mutate the input array', () => {
    const tools: KinbotTool[] = [
      { name: 'a', description: 'A', inputSchema: { type: 'object' } },
    ]
    const out = markLastKinbotToolCacheable(tools)
    expect(out).not.toBe(tools)
    expect(tools[0]!.cacheControl).toBeUndefined()
    expect(out[0]!.cacheControl).toEqual({ type: 'ephemeral' })
  })
})

// ─── splitSystemFromVercelMessages ───────────────────────────────────────────

describe('splitSystemFromVercelMessages', () => {
  it('extracts the leading system message into a kinbot SystemPrompt', () => {
    const { system, messages } = splitSystemFromVercelMessages([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
    ])
    expect(system).toBeDefined()
    expect(system![0]).toMatchObject({ type: 'text', text: 'You are a helpful assistant.' })
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('user')
  })

  it('returns system undefined when there is no system message', () => {
    const { system, messages } = splitSystemFromVercelMessages([
      { role: 'user', content: 'Hello' },
    ])
    expect(system).toBeUndefined()
    expect(messages).toHaveLength(1)
  })

  it('promotes anthropic cacheControl from message-level to the system block', () => {
    const { system } = splitSystemFromVercelMessages([
      {
        role: 'system',
        content: 'cached system',
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
    ])
    expect(system![0]!.cacheControl).toEqual({ type: 'ephemeral' })
  })

  it('keeps multiple system blocks ordered', () => {
    // buildSegmentedMessages can emit several system messages on Anthropic
    // for multi-segment system prompts. The split must keep their order.
    const { system } = splitSystemFromVercelMessages([
      { role: 'system', content: 'one' },
      { role: 'system', content: 'two' },
      { role: 'user', content: 'go' },
    ])
    expect(system).toHaveLength(2)
    expect(system![0]!.text).toBe('one')
    expect(system![1]!.text).toBe('two')
  })
})

// ─── modelMessagesToKinbot ───────────────────────────────────────────────────

describe('modelMessagesToKinbot', () => {
  it('drops system messages (handled separately by splitSystemFromVercelMessages)', () => {
    const out = modelMessagesToKinbot([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.role).toBe('user')
  })

  it('converts a string user message to a single text block', () => {
    const out = modelMessagesToKinbot([{ role: 'user', content: 'hello' }])
    expect(out[0]!.content).toHaveLength(1)
    expect(out[0]!.content[0]).toMatchObject({ type: 'text', text: 'hello' })
  })

  it('converts a tool-role message into a user message of tool-result blocks', () => {
    // OpenAI-style tool messages are flattened into Anthropic-style tool
    // results on a user turn.
    const out = modelMessagesToKinbot([
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'call_1', toolName: 'foo', output: { type: 'json', value: { ok: true } } },
        ],
      },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.role).toBe('user')
    expect(out[0]!.content[0]).toMatchObject({
      type: 'tool-result',
      toolUseId: 'call_1',
    })
  })

  it('preserves assistant tool-call blocks', () => {
    const out = modelMessagesToKinbot([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'using a tool' },
          { type: 'tool-call', toolCallId: 'call_x', toolName: 'foo', input: { a: 1 } },
        ],
      },
    ])
    expect(out[0]!.role).toBe('assistant')
    const blocks = out[0]!.content
    expect(blocks).toContainEqual({ type: 'text', text: 'using a tool' })
    expect(blocks).toContainEqual({
      type: 'tool-use',
      id: 'call_x',
      name: 'foo',
      args: { a: 1 },
    })
  })
})
