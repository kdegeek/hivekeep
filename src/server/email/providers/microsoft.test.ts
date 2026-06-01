import { describe, it, expect } from 'bun:test'
import {
  buildGraphSearch,
  buildSendPayload,
  graphMessageToSummary,
  graphToAddr,
  addrToGraph,
} from '@/server/email/providers/microsoft'

describe('buildGraphSearch', () => {
  it('returns raw passthrough when set', () => {
    expect(buildGraphSearch({ raw: 'from:x subject:hi' })).toBe('from:x subject:hi')
  })

  it('maps structured fields to a KQL search string', () => {
    const s = buildGraphSearch({ from: 'a@b.com', subject: 'Hello', text: 'invoice' })
    expect(s).toContain('from:a@b.com')
    expect(s).toContain('subject:Hello')
    expect(s).toContain('invoice')
  })

  it('is empty for an undefined query', () => {
    expect(buildGraphSearch(undefined)).toBe('')
  })
})

describe('address mapping', () => {
  it('round-trips an address through Graph shape', () => {
    const a = { email: 'a@x.com', name: 'Al' }
    expect(graphToAddr(addrToGraph(a))).toEqual(a)
  })

  it('drops the name when absent', () => {
    expect(addrToGraph({ email: 'a@x' })).toEqual({ emailAddress: { address: 'a@x' } })
  })

  it('returns undefined for a recipient without an address', () => {
    expect(graphToAddr(undefined)).toBeUndefined()
    expect(graphToAddr({ emailAddress: {} })).toBeUndefined()
  })
})

describe('graphMessageToSummary', () => {
  it('maps a Graph message to a summary', () => {
    const s = graphMessageToSummary({
      id: 'm1',
      conversationId: 'c1',
      subject: 'Hi',
      bodyPreview: 'preview',
      receivedDateTime: '2026-01-15T10:00:00Z',
      isRead: false,
      hasAttachments: true,
      from: { emailAddress: { address: 'a@x', name: 'A' } },
      toRecipients: [{ emailAddress: { address: 'b@y' } }],
    })
    expect(s.id).toBe('m1')
    expect(s.threadId).toBe('c1')
    expect(s.from).toEqual({ email: 'a@x', name: 'A' })
    expect(s.to).toEqual([{ email: 'b@y' }])
    expect(s.unread).toBe(true)
    expect(s.hasAttachments).toBe(true)
    expect(s.date).toBe(Date.parse('2026-01-15T10:00:00Z'))
  })

  it('treats a read message as not unread and defaults the subject', () => {
    const s = graphMessageToSummary({ id: 'm2', isRead: true })
    expect(s.unread).toBe(false)
    expect(s.subject).toBe('(no subject)')
    expect(s.to).toEqual([])
  })
})

describe('buildSendPayload', () => {
  it('builds a plain-text message', () => {
    const p = buildSendPayload({ to: [{ email: 'a@x' }], subject: 'Hi', body: 'hello' }) as any
    expect(p.saveToSentItems).toBe(true)
    expect(p.message.subject).toBe('Hi')
    expect(p.message.body).toEqual({ contentType: 'Text', content: 'hello' })
    expect(p.message.toRecipients).toEqual([{ emailAddress: { address: 'a@x' } }])
  })

  it('prefers HTML body when provided', () => {
    const p = buildSendPayload({ to: [{ email: 'a@x' }], subject: 'H', body: 't', bodyHtml: '<b>t</b>' }) as any
    expect(p.message.body).toEqual({ contentType: 'HTML', content: '<b>t</b>' })
  })

  it('adds cc/bcc and fileAttachments', () => {
    const p = buildSendPayload({
      to: [{ email: 'a@x' }],
      cc: [{ email: 'c@x' }],
      bcc: [{ email: 'd@x' }],
      subject: 'S',
      body: 'b',
      attachments: [{ filename: 'r.pdf', mimeType: 'application/pdf', contentBase64: 'AAAA' }],
    }) as any
    expect(p.message.ccRecipients).toEqual([{ emailAddress: { address: 'c@x' } }])
    expect(p.message.bccRecipients).toEqual([{ emailAddress: { address: 'd@x' } }])
    expect(p.message.attachments).toEqual([
      {
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: 'r.pdf',
        contentType: 'application/pdf',
        contentBytes: 'AAAA',
      },
    ])
  })
})
