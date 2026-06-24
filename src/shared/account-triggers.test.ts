import { describe, it, expect } from 'bun:test'
import {
  validateConditionTree,
  parseAndValidateConditions,
  treeNeedsBody,
  evaluateConditions,
  summarizeConditions,
  stripMessageId,
  MAX_CONDITION_DEPTH,
  type EmailMatchContext,
} from './account-triggers'
import type { ConditionNode } from './types'

const baseCtx: EmailMatchContext = {
  senderEmail: 'billing@Stripe.com',
  senderName: 'Stripe Billing',
  senderDomain: 'stripe.com',
  subject: 'Your Invoice #1234',
  snippet: 'Your invoice for May is ready',
  recipients: ['niko+stripe@example.com'],
  hasAttachment: true,
  unread: true,
  labels: ['INBOX', 'IMPORTANT'],
  threadId: 'thread-abc123',
  inReplyTo: 'sent-msg-id@hivekeep.example',
  body: 'Total due: 42 EUR',
  attachmentNames: ['invoice.pdf'],
  attachmentTypes: ['application/pdf'],
}

const g = (op: 'and' | 'or', ...children: ConditionNode[]): ConditionNode => ({ type: 'group', op, children })
const leaf = (field: any, op: any, value: any, negate?: boolean): ConditionNode => ({ type: 'leaf', field, op, value, ...(negate ? { negate } : {}) })

describe('evaluateConditions', () => {
  it('matches sender_domain equals (case-insensitive)', () => {
    expect(evaluateConditions(g('and', leaf('sender_domain', 'equals', 'STRIPE.com')), baseCtx)).toBe(true)
  })

  it('AND requires all, OR requires any', () => {
    expect(evaluateConditions(g('and', leaf('subject', 'contains', 'invoice'), leaf('sender_domain', 'equals', 'nope.com')), baseCtx)).toBe(false)
    expect(evaluateConditions(g('or', leaf('subject', 'contains', 'invoice'), leaf('sender_domain', 'equals', 'nope.com')), baseCtx)).toBe(true)
  })

  it('nested groups evaluate recursively', () => {
    const tree = g('and',
      leaf('sender_domain', 'equals', 'stripe.com'),
      g('or', leaf('subject', 'contains', 'invoice'), g('and', leaf('has_attachment', 'is_true', true), leaf('body', 'contains', 'total'))),
    )
    expect(evaluateConditions(tree, baseCtx)).toBe(true)
  })

  it('negate inverts a leaf', () => {
    expect(evaluateConditions(g('and', leaf('subject', 'contains', 'invoice', true)), baseCtx)).toBe(false)
    expect(evaluateConditions(g('and', leaf('subject', 'contains', 'refund', true)), baseCtx)).toBe(true)
  })

  it('boolean ops read has_attachment / unread', () => {
    expect(evaluateConditions(g('and', leaf('has_attachment', 'is_false', true)), baseCtx)).toBe(false)
    expect(evaluateConditions(g('and', leaf('unread', 'is_true', true)), baseCtx)).toBe(true)
  })

  it('multi-value fields match if ANY element matches (recipient sub-addressing)', () => {
    expect(evaluateConditions(g('and', leaf('recipient', 'contains', '+stripe')), baseCtx)).toBe(true)
    expect(evaluateConditions(g('and', leaf('label', 'in', ['important'])), baseCtx)).toBe(true)
  })

  it('thread_id equals matches the reply-watch thread (any sender)', () => {
    expect(evaluateConditions(g('and', leaf('thread_id', 'equals', 'thread-abc123')), baseCtx)).toBe(true)
    expect(evaluateConditions(g('and', leaf('thread_id', 'equals', 'other-thread')), baseCtx)).toBe(false)
    expect(evaluateConditions(g('and', leaf('thread_id', 'in', ['x', 'thread-abc123'])), baseCtx)).toBe(true)
  })

  it('in_reply_to equals matches an IMAP reply by Message-ID (case-insensitive)', () => {
    expect(evaluateConditions(g('and', leaf('in_reply_to', 'equals', 'sent-msg-id@hivekeep.example')), baseCtx)).toBe(true)
    expect(evaluateConditions(g('and', leaf('in_reply_to', 'equals', 'SENT-MSG-ID@Hivekeep.Example')), baseCtx)).toBe(true)
    expect(evaluateConditions(g('and', leaf('in_reply_to', 'equals', 'other-id@host')), baseCtx)).toBe(false)
  })

  it('matches uses regex (case-insensitive)', () => {
    expect(evaluateConditions(g('and', leaf('subject', 'matches', 'invoice #\\d+')), baseCtx)).toBe(true)
    expect(evaluateConditions(g('and', leaf('subject', 'matches', '^refund')), baseCtx)).toBe(false)
  })
})

describe('stripMessageId', () => {
  it('drops angle brackets so a sent id and an incoming In-Reply-To compare equal', () => {
    expect(stripMessageId('<abc@host>')).toBe('abc@host')
    expect(stripMessageId('abc@host')).toBe('abc@host')
  })
  it('keeps the first id when the header lists several, and tolerates empty input', () => {
    expect(stripMessageId('<a@host> <b@host>')).toBe('a@host')
    expect(stripMessageId(undefined)).toBe('')
    expect(stripMessageId('')).toBe('')
  })
})

describe('validateConditionTree', () => {
  it('accepts a valid tree', () => {
    expect(validateConditionTree(g('and', leaf('subject', 'contains', 'x'))).ok).toBe(true)
  })
  it('rejects a non-group root', () => {
    expect(validateConditionTree(leaf('subject', 'contains', 'x')).ok).toBe(false)
  })
  it('rejects an empty group', () => {
    expect(validateConditionTree({ type: 'group', op: 'and', children: [] }).ok).toBe(false)
  })
  it('rejects a bad operator for a field', () => {
    const r = validateConditionTree(g('and', leaf('has_attachment', 'contains', 'x')))
    expect(r.ok).toBe(false)
  })
  it('rejects an uncompilable regex', () => {
    const r = validateConditionTree(g('and', leaf('subject', 'matches', '(')))
    expect(r.ok).toBe(false)
  })
  it('rejects nesting deeper than the max', () => {
    let node: ConditionNode = leaf('subject', 'contains', 'x')
    for (let i = 0; i < MAX_CONDITION_DEPTH + 1; i++) node = g('and', node)
    expect(validateConditionTree(node).ok).toBe(false)
  })
  it('rejects `in` without a non-empty list', () => {
    expect(validateConditionTree(g('and', leaf('label', 'in', 'important'))).ok).toBe(false)
  })
})

describe('parseAndValidateConditions', () => {
  it('rejects invalid JSON with a message', () => {
    const r = parseAndValidateConditions('{not json')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('JSON')
  })
  it('round-trips a valid JSON tree', () => {
    const r = parseAndValidateConditions(JSON.stringify(g('and', leaf('subject', 'contains', 'x'))))
    expect(r.ok).toBe(true)
  })
})

describe('treeNeedsBody', () => {
  it('is false for summary-only fields', () => {
    expect(treeNeedsBody(g('and', leaf('subject', 'contains', 'x'), leaf('sender_domain', 'equals', 'y.com')))).toBe(false)
  })
  it('is true when a body/attachment field appears anywhere', () => {
    expect(treeNeedsBody(g('and', leaf('subject', 'contains', 'x'), g('or', leaf('body', 'contains', 'total'))))).toBe(true)
  })
})

describe('summarizeConditions', () => {
  it('renders a readable one-liner', () => {
    const tree = g('and', leaf('sender_domain', 'equals', 'stripe.com'), g('or', leaf('subject', 'contains', 'invoice'), leaf('has_attachment', 'is_true', true)))
    const s = summarizeConditions(tree)
    expect(s).toContain('sender domain = "stripe.com"')
    expect(s).toContain('AND')
    expect(s).toContain('OR')
  })
})
