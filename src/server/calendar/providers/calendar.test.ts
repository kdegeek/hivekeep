import { describe, it, expect } from 'bun:test'
import { googleEventToEvent, toGoogleTime, buildGoogleEventBody } from '@/server/calendar/providers/google'
import { graphEventToEvent, toGraphTime, buildGraphEventBody } from '@/server/calendar/providers/microsoft'
import { parseVEvent, buildVEvent } from '@/server/calendar/providers/caldav-core'

describe('Google calendar mapping', () => {
  it('maps a timed event', () => {
    const e = googleEventToEvent(
      {
        id: 'e1',
        summary: 'Dentist',
        location: 'Clinic',
        start: { dateTime: '2026-06-10T14:00:00+02:00', timeZone: 'Europe/Paris' },
        end: { dateTime: '2026-06-10T15:00:00+02:00' },
        htmlLink: 'https://cal/e1',
        attendees: [{ email: 'a@x.com', displayName: 'Al', responseStatus: 'accepted' }],
      },
      'primary',
    )
    expect(e.title).toBe('Dentist')
    expect(e.allDay).toBe(false)
    expect(e.start).toBe('2026-06-10T14:00:00+02:00')
    expect(e.timeZone).toBe('Europe/Paris')
    expect(e.attendees).toEqual([{ email: 'a@x.com', name: 'Al', responseStatus: 'accepted' }])
  })

  it('maps an all-day event', () => {
    const e = googleEventToEvent({ id: 'e2', summary: 'Trip', start: { date: '2026-06-10' }, end: { date: '2026-06-12' } }, 'primary')
    expect(e.allDay).toBe(true)
    expect(e.start).toBe('2026-06-10')
  })

  it('builds a create body (timed + all-day)', () => {
    expect(toGoogleTime('2026-06-10T14:00:00Z', false, 'UTC')).toEqual({ dateTime: '2026-06-10T14:00:00Z', timeZone: 'UTC' })
    expect(toGoogleTime('2026-06-10', true)).toEqual({ date: '2026-06-10' })
    const body = buildGoogleEventBody({ title: 'X', start: '2026-06-10T14:00:00Z', end: '2026-06-10T15:00:00Z' }) as Record<string, unknown>
    expect(body.summary).toBe('X')
    expect((body.start as Record<string, unknown>).dateTime).toBe('2026-06-10T14:00:00Z')
  })
})

describe('Microsoft calendar mapping', () => {
  it('maps an event and strips HTML body', () => {
    const e = graphEventToEvent(
      {
        id: 'g1',
        subject: 'Sync',
        body: { contentType: 'html', content: '<p>Hello <b>world</b></p>' },
        location: { displayName: 'Room 1' },
        start: { dateTime: '2026-06-10T14:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-06-10T15:00:00.0000000', timeZone: 'UTC' },
        webLink: 'https://outlook/g1',
      },
      'default',
    )
    expect(e.title).toBe('Sync')
    expect(e.description).toBe('Hello world')
    expect(e.location).toBe('Room 1')
    expect(e.timeZone).toBe('UTC')
  })

  it('normalizes write times to UTC + strips offset', () => {
    expect(toGraphTime('2026-06-10T14:00:00Z', false)).toEqual({ dateTime: '2026-06-10T14:00:00.000', timeZone: 'UTC' })
    expect(toGraphTime('2026-06-10', true)).toEqual({ dateTime: '2026-06-10T00:00:00', timeZone: 'UTC' })
    const body = buildGraphEventBody({ title: 'X', description: 'd' }) as Record<string, unknown>
    expect(body.subject).toBe('X')
    expect(body.body).toEqual({ contentType: 'text', content: 'd' })
  })
})

describe('CalDAV iCal roundtrip', () => {
  it('parses a VEVENT', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:abc',
      'SUMMARY:Dentist',
      'LOCATION:Clinic',
      'DTSTART:20260610T140000Z',
      'DTEND:20260610T150000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    const e = parseVEvent(ics)
    expect(e?.title).toBe('Dentist')
    expect(e?.location).toBe('Clinic')
    expect(e?.allDay).toBe(false)
    expect(e?.start).toBe('2026-06-10T14:00:00.000Z')
  })

  it('builds then re-parses an event (roundtrip)', () => {
    const ics = buildVEvent({ uid: 'u1', title: 'Meeting', start: '2026-06-10T09:00:00Z', end: '2026-06-10T10:00:00Z' })
    expect(ics).toContain('BEGIN:VEVENT')
    expect(ics).toContain('SUMMARY:Meeting')
    const e = parseVEvent(ics)
    expect(e?.title).toBe('Meeting')
    expect(e?.start).toBe('2026-06-10T09:00:00.000Z')
  })

  it('builds an all-day event as a DATE', () => {
    const ics = buildVEvent({ uid: 'u2', title: 'Trip', start: '2026-06-10', end: '2026-06-12', allDay: true })
    const e = parseVEvent(ics)
    expect(e?.allDay).toBe(true)
    expect(e?.start).toBe('2026-06-10')
  })
})
