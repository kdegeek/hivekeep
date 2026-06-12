import { describe, it, expect } from 'bun:test'
import { formatTicketRef } from '@/client/lib/ticket-ref'

describe('formatTicketRef', () => {
  it('returns a bare ref when no slug is given', () => {
    expect(formatTicketRef(42)).toBe('#42')
  })

  it('qualifies the ref with the slug when provided', () => {
    expect(formatTicketRef(42, 'hivekeep')).toBe('hivekeep#42')
  })

  it('treats an empty slug as absent (legacy projects)', () => {
    expect(formatTicketRef(42, '')).toBe('#42')
  })

  it('returns null when the number is missing (legacy tickets)', () => {
    expect(formatTicketRef(null)).toBeNull()
    expect(formatTicketRef(undefined)).toBeNull()
    expect(formatTicketRef(null, 'hivekeep')).toBeNull()
  })

  it('handles number zero as a valid ref', () => {
    expect(formatTicketRef(0)).toBe('#0')
  })
})
