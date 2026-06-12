import { describe, it, expect } from 'bun:test'
import { stripMarkdown } from './strip-markdown'

describe('stripMarkdown', () => {
  it('returns empty string for nullish input', () => {
    expect(stripMarkdown(null)).toBe('')
    expect(stripMarkdown(undefined)).toBe('')
    expect(stripMarkdown('')).toBe('')
  })

  it('strips heading markers', () => {
    expect(stripMarkdown('# Hivekeep')).toBe('Hivekeep')
    expect(stripMarkdown('### A heading')).toBe('A heading')
  })

  it('unwraps strong and emphasis', () => {
    expect(stripMarkdown('**bold** and *italic*')).toBe('bold and italic')
    expect(stripMarkdown('__bold__ and _italic_')).toBe('bold and italic')
  })

  it('strips strikethrough', () => {
    expect(stripMarkdown('~~gone~~ here')).toBe('gone here')
  })

  it('unwraps inline code', () => {
    expect(stripMarkdown('use `bun test` now')).toBe('use bun test now')
  })

  it('keeps link text, drops url', () => {
    expect(stripMarkdown('see [the repo](https://example.com)')).toBe('see the repo')
  })

  it('keeps image alt text', () => {
    expect(stripMarkdown('![logo](https://example.com/x.png) done')).toBe('logo done')
  })

  it('drops list markers and blockquotes', () => {
    expect(stripMarkdown('- item one\n- item two')).toBe('item one item two')
    expect(stripMarkdown('> quoted line')).toBe('quoted line')
    expect(stripMarkdown('1. first\n2. second')).toBe('first second')
  })

  it('collapses newlines and whitespace into single spaces', () => {
    expect(stripMarkdown('line one\n\nline two')).toBe('line one line two')
    expect(stripMarkdown('a    b\tc')).toBe('a b c')
  })

  it('handles fenced code blocks', () => {
    expect(stripMarkdown('text\n```ts\nconst a = 1\n```\nmore')).toBe('text const a = 1 more')
  })

  it('handles a realistic project description', () => {
    const input = '# Hivekeep\n\nPlateforme **self-hosted** multi-agent. Repo: [link](https://github.com/x/y)\n\n## Architecture\n\n- Bun\n- Hono'
    expect(stripMarkdown(input)).toBe('Hivekeep Plateforme self-hosted multi-agent. Repo: link Architecture Bun Hono')
  })
})
