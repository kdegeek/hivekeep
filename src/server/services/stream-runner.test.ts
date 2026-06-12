import { describe, expect, it } from 'bun:test'
import { runStreamStep, type StreamStepContext, type ReasoningSegment } from './stream-runner'
import type { ChatChunk } from '@/server/llm/llm/types'

/** Build a minimal async stream from a fixed chunk list. */
async function* fakeStream(chunks: ChatChunk[]): AsyncIterable<ChatChunk> {
  for (const c of chunks) yield c
}

function baseCtx(over: Partial<StreamStepContext> = {}): StreamStepContext {
  return {
    agentId: 'agent-test',
    assistantMessageId: 'msg-test',
    abortController: new AbortController(),
    ...over,
  }
}

describe('runStreamStep — thinking capture for cross-step re-injection', () => {
  it('captures a signed thinking block on a tool-call step (text is still dropped)', async () => {
    const chunks: ChatChunk[] = [
      { type: 'thinking-delta', text: 'Let me ' },
      { type: 'thinking-delta', text: 'inspect the file.' },
      { type: 'thinking-signature', signature: 'sig-abc' },
      { type: 'text-delta', text: 'I will read it now' }, // pre-narration → dropped
      { type: 'tool-use', id: 't1', name: 'read_file', args: { path: 'a.ts' } },
      { type: 'finish', reason: 'tool-calls', usage: { outputTokens: 5 } },
    ]
    const outcome = await runStreamStep(fakeStream(chunks), baseCtx(), 0)

    // Intermediate (tool) step → narration dropped, but the signed thinking
    // block is exposed so the caller can re-inject it.
    expect(outcome.stepText).toBe('')
    expect(outcome.stepToolCalls).toHaveLength(1)
    expect(outcome.stepToolCalls[0]!.name).toBe('read_file')
    expect(outcome.stepThinking).toEqual([
      { text: 'Let me inspect the file.', signature: 'sig-abc' },
    ])
  })

  it('keeps text on a pure-text final step AND still exposes the thinking block', async () => {
    const chunks: ChatChunk[] = [
      { type: 'thinking-delta', text: 'The answer is 42.' },
      { type: 'thinking-signature', signature: 'sig-final' },
      { type: 'text-delta', text: 'The answer is 42.' },
      { type: 'finish', reason: 'stop', usage: { outputTokens: 3 } },
    ]
    const outcome = await runStreamStep(fakeStream(chunks), baseCtx(), 0)

    expect(outcome.stepText).toBe('The answer is 42.')
    expect(outcome.stepToolCalls).toHaveLength(0)
    expect(outcome.stepThinking).toEqual([
      { text: 'The answer is 42.', signature: 'sig-final' },
    ])
  })

  it('leaves signature undefined for an unsigned thinking block (non-Anthropic / interrupted)', async () => {
    const chunks: ChatChunk[] = [
      { type: 'thinking-delta', text: 'unsigned reasoning' },
      { type: 'text-delta', text: 'done' },
      { type: 'finish', reason: 'stop', usage: {} },
    ]
    const outcome = await runStreamStep(fakeStream(chunks), baseCtx(), 0)

    expect(outcome.stepThinking).toEqual([{ text: 'unsigned reasoning', signature: undefined }])
  })

  it('pairs each of multiple thinking blocks with its OWN signature (never merged)', async () => {
    const chunks: ChatChunk[] = [
      { type: 'thinking-delta', text: 'first thought' },
      { type: 'thinking-signature', signature: 'sig-1' },
      { type: 'tool-use', id: 't1', name: 'grep', args: { q: 'x' } },
      { type: 'thinking-delta', text: 'second thought' },
      { type: 'thinking-signature', signature: 'sig-2' },
      { type: 'tool-use', id: 't2', name: 'grep', args: { q: 'y' } },
      { type: 'finish', reason: 'tool-calls', usage: {} },
    ]
    const outcome = await runStreamStep(fakeStream(chunks), baseCtx(), 0)

    expect(outcome.stepThinking).toEqual([
      { text: 'first thought', signature: 'sig-1' },
      { text: 'second thought', signature: 'sig-2' },
    ])
    expect(outcome.stepToolCalls.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('writes the signature into reasoningSegments too (the persistence channel)', async () => {
    const reasoningSegments: ReasoningSegment[] = []
    const chunks: ChatChunk[] = [
      { type: 'thinking-delta', text: 'persisted thought' },
      { type: 'thinking-signature', signature: 'sig-persist' },
      { type: 'tool-use', id: 't1', name: 'list_directory', args: {} },
      { type: 'finish', reason: 'tool-calls', usage: {} },
    ]
    await runStreamStep(fakeStream(chunks), baseCtx({ reasoningSegments }), 0)

    expect(reasoningSegments).toHaveLength(1)
    expect(reasoningSegments[0]!.text).toBe('persisted thought')
    expect(reasoningSegments[0]!.signature).toBe('sig-persist')
  })
})
