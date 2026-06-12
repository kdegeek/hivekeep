import { describe, expect, it } from 'bun:test'
import {
  mapModel,
  createThinkParser,
  type MiniMaxModel,
  type ThinkSegment,
} from './minimax'

// Representative fixtures drawn from the live /models payload shape:
// the bare OpenAI listing `{object:'list', data:[{id, object, owned_by}]}`.
// Live ids (confirmed against GET /v1/models): MiniMax-M3, MiniMax-M2.7,
// MiniMax-M2.7-highspeed, MiniMax-M2.5, MiniMax-M2.5-highspeed, MiniMax-M2.1,
// MiniMax-M2.1-highspeed, MiniMax-M2.

const m3: MiniMaxModel = { id: 'MiniMax-M3', object: 'model', owned_by: 'minimax' }
const m27: MiniMaxModel = { id: 'MiniMax-M2.7', object: 'model', owned_by: 'minimax' }
const m27hs: MiniMaxModel = {
  id: 'MiniMax-M2.7-highspeed',
  object: 'model',
  owned_by: 'minimax',
}
const m2: MiniMaxModel = { id: 'MiniMax-M2', object: 'model', owned_by: 'minimax' }

// ─── mapModel (metadata now comes from the registry, not heuristics) ─────────

describe('mapModel', () => {
  it('returns the bare model — no name-based context/vision guesses', () => {
    const m = mapModel(m3)!
    expect(m.id).toBe('MiniMax-M3')
    expect(m.name).toBe('MiniMax-M3')
    expect(m.supportsPromptCaching).toBe(true)
    expect(m.supportsParallelTools).toBe(true)
    // Context window + vision (M3 multimodal) are filled by the registry.
    expect(m.contextWindow).toBeUndefined()
    expect(m.supportsImageInput).toBeUndefined()
    expect(m.thinking).toBeUndefined()
  })

  it('returns null for entries without an id', () => {
    expect(mapModel({ id: '' })).toBeNull()
  })
})

// ─── listModels payload parsing ──────────────────────────────────────────────

describe('listModels payload shape', () => {
  // The provider's listModels reads `payload.data` from the OpenAI-style
  // `{object:'list', data:[{id}]}` response. Verify mapModel handles the full
  // listing (including a degenerate id-less entry) the way listModels does.
  it('maps every model in a {data:[{id}]} listing, dropping id-less entries', () => {
    const payload: { object: string; data: MiniMaxModel[] } = {
      object: 'list',
      data: [m3, m27, m27hs, m2, { id: '' }],
    }
    const mapped = payload.data
      .map(mapModel)
      .filter((m): m is NonNullable<typeof m> => m !== null)
    expect(mapped.map((m) => m.id)).toEqual([
      'MiniMax-M3',
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2',
    ])
  })
})

// ─── Inline <think> stream parser (THE SPECIAL PART) ─────────────────────────

/**
 * Feed a sequence of streamed delta.content chunks through the parser
 * (push each, then flush) and collapse adjacent same-kind segments so the
 * assertions compare logical reasoning vs answer rather than chunk geometry.
 */
function run(chunks: string[]): { thinking: string; answer: string; segs: ThinkSegment[] } {
  const parser = createThinkParser()
  const segs: ThinkSegment[] = []
  for (const c of chunks) segs.push(...parser.push(c))
  segs.push(...parser.flush())
  let thinking = ''
  let answer = ''
  for (const s of segs) {
    if (s.kind === 'thinking') thinking += s.text
    else answer += s.text
  }
  return { thinking, answer, segs }
}

describe('createThinkParser', () => {
  it('separates a complete <think>…</think> wrapper from the answer (single chunk)', () => {
    const { thinking, answer } = run(['<think>\nThe user asks 2+2...\n</think>\n\nFour'])
    expect(thinking).toBe('\nThe user asks 2+2...\n')
    expect(answer).toBe('\n\nFour')
  })

  it('handles the OPEN tag split across two chunks ("<thi" then "nk>")', () => {
    const { thinking, answer } = run(['<thi', 'nk>reasoning</think>answer'])
    expect(thinking).toBe('reasoning')
    expect(answer).toBe('answer')
  })

  it('handles the CLOSE tag split across two chunks ("</thin" then "k>")', () => {
    const { thinking, answer } = run(['<think>reasoning</thin', 'k>answer'])
    expect(thinking).toBe('reasoning')
    expect(answer).toBe('answer')
  })

  it('handles both tags fragmented across many tiny chunks', () => {
    const chunks = '<think>abc</think>xyz'.split('') // one char at a time
    const { thinking, answer } = run(chunks)
    expect(thinking).toBe('abc')
    expect(answer).toBe('xyz')
  })

  it('streams plain text-delta when no <think> wrapper is present', () => {
    const { thinking, answer, segs } = run(['Hello, ', 'world!'])
    expect(thinking).toBe('')
    expect(answer).toBe('Hello, world!')
    // Nothing should be misrouted to thinking.
    expect(segs.every((s) => s.kind === 'answer')).toBe(true)
  })

  it('does not treat a mid-answer "<think>" substring as a new reasoning block', () => {
    // Once real answer text has been emitted, the parser is in 'answer' state
    // and a stray "<think>" is just text.
    const { thinking, answer } = run(['Here is code: ', 'if x: <think>nope</think> done'])
    expect(thinking).toBe('')
    expect(answer).toBe('Here is code: if x: <think>nope</think> done')
  })

  it('tolerates leading whitespace before the opening tag', () => {
    const { thinking, answer } = run(['\n', '  <think>r</think>a'])
    expect(thinking).toBe('r')
    expect(answer).toBe('a')
  })

  it('treats an unterminated <think> at end-of-stream as reasoning', () => {
    const { thinking, answer } = run(['<think>still thinking when the stream ended'])
    expect(thinking).toBe('still thinking when the stream ended')
    expect(answer).toBe('')
  })

  it('emits empty answer (not a stray segment) when content is reasoning-only with close', () => {
    const { thinking, answer } = run(['<think>only reasoning</think>'])
    expect(thinking).toBe('only reasoning')
    expect(answer).toBe('')
  })
})
