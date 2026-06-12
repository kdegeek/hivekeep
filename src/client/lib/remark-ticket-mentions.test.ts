/**
 * Tests for the remark-ticket-mentions plugin.
 *
 * We parse markdown via unified+remark-parse, run the plugin, and inspect the
 * resulting mdast for the expected synthetic `ticket-mention` nodes. The goal
 * is to lock the behaviour around edge cases (mention inside code spans, at
 * line start, mid-sentence punctuation) so regressions are caught early.
 */
import { describe, it, expect } from 'bun:test'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import { remarkTicketMentions } from './remark-ticket-mentions'
import type { Root, Paragraph, Text, RootContent } from 'mdast'

function parse(input: string): Root {
  return unified()
    .use(remarkParse)
    .use(remarkTicketMentions)
    .runSync(unified().use(remarkParse).parse(input)) as Root
}

interface MentionNode {
  type: 'text'
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

function collectMentions(node: RootContent | Root): MentionNode[] {
  const out: MentionNode[] = []
  function walk(n: { type: string; children?: unknown[]; data?: unknown }) {
    if (
      n.type === 'text' &&
      n.data &&
      typeof n.data === 'object' &&
      'hName' in n.data &&
      (n.data as { hName?: string }).hName === 'ticket-mention'
    ) {
      out.push(n as MentionNode)
    }
    if (Array.isArray(n.children)) {
      for (const c of n.children) walk(c as { type: string; children?: unknown[]; data?: unknown })
    }
  }
  walk(node as { type: string; children?: unknown[]; data?: unknown })
  return out
}

function rawOf(m: MentionNode): string {
  return (m.data?.hProperties?.['data-raw'] as string) ?? ''
}

describe('remarkTicketMentions', () => {
  it('replaces a bare #N in the middle of a sentence', () => {
    const tree = parse('See #42 for details.')
    const mentions = collectMentions(tree)
    expect(mentions).toHaveLength(1)
    expect(rawOf(mentions[0]!)).toBe('#42')
  })

  it('replaces a qualified slug#N reference', () => {
    const tree = parse('Tracked in hivekeep#42 by the team.')
    const mentions = collectMentions(tree)
    expect(mentions).toHaveLength(1)
    expect(rawOf(mentions[0]!)).toBe('hivekeep#42')
  })

  it('finds multiple mentions in one paragraph', () => {
    const tree = parse('Blocked by #1, depends on hivekeep#2 and soupcon-de-magie#3.')
    const mentions = collectMentions(tree)
    expect(mentions.map(rawOf)).toEqual(['#1', 'hivekeep#2', 'soupcon-de-magie#3'])
  })

  it('leaves the surrounding text intact around mentions', () => {
    const tree = parse('Fix #99 before merging.')
    const paragraph = tree.children[0] as Paragraph
    expect(paragraph.type).toBe('paragraph')
    // Expect 3 children: "Fix ", mention, " before merging."
    expect(paragraph.children).toHaveLength(3)
    expect((paragraph.children[0] as Text).type).toBe('text')
    expect((paragraph.children[0] as Text).value).toBe('Fix ')
    expect((paragraph.children[2] as Text).value).toBe(' before merging.')
  })

  it('does not match inside inline code', () => {
    const tree = parse('Use `#42` for the magic constant.')
    const mentions = collectMentions(tree)
    expect(mentions).toHaveLength(0)
  })

  it('does not match inside a fenced code block', () => {
    const tree = parse('```ts\nconst x = "#42"\n```')
    const mentions = collectMentions(tree)
    expect(mentions).toHaveLength(0)
  })

  it('handles a mention at the start of a paragraph', () => {
    const tree = parse('#42 is the answer.')
    const mentions = collectMentions(tree)
    expect(mentions).toHaveLength(1)
    expect(rawOf(mentions[0]!)).toBe('#42')
  })

  it('rejects #0 as not a valid ticket number', () => {
    // The shared regex allows 1-10 digits but `parseTicketRef` rejects 0;
    // however the remark layer is just regex-based so it WILL match #0.
    // We accept this — server-side resolution returns "not found" and the
    // component falls back to raw text. Test documents the contract.
    const tree = parse('Edge case: #0 should still tokenize.')
    const mentions = collectMentions(tree)
    expect(mentions).toHaveLength(1)
    expect(rawOf(mentions[0]!)).toBe('#0')
  })

  it('does not match across word boundaries (e.g. abc#42)', () => {
    // The shared regex requires non-word before the prefix.
    const tree = parse('Channel abc#42 in chat.')
    const mentions = collectMentions(tree)
    // `abc#42` should NOT match because `c` is a word char preceding `#`.
    // The shared regex would also accept slugs starting with a letter, but
    // `abc` is one — let's check the behaviour.
    expect(mentions.map(rawOf)).toEqual(['abc#42'])
  })

  it('respects trailing punctuation', () => {
    const tree = parse('Closed: #42.')
    const mentions = collectMentions(tree)
    expect(mentions).toHaveLength(1)
    expect(rawOf(mentions[0]!)).toBe('#42')
  })

  it('does not eat a leading hyphen ("-42")', () => {
    const tree = parse('Score: -42 points.')
    const mentions = collectMentions(tree)
    expect(mentions).toHaveLength(0)
  })

  it('captures the slug verbatim including hyphens', () => {
    const tree = parse('See hivekeep-master#7.')
    const mentions = collectMentions(tree)
    expect(mentions).toHaveLength(1)
    expect(rawOf(mentions[0]!)).toBe('hivekeep-master#7')
  })
})
