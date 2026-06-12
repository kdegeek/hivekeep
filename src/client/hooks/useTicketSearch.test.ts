/**
 * Tests for `buildTicketSearchUrl` — the pure URL-building helper used by
 * `useTicketSearch`. We test the helper directly rather than the hook itself
 * because the project does not pull in a DOM-aware React test renderer.
 *
 * The helper is the only piece of the hook that contains branching logic
 * worth covering (which scope wins, optional flags, empty inputs). The
 * surrounding hook is a thin wrapper around setTimeout + setState.
 */
import { describe, it, expect } from 'bun:test'
import { buildTicketSearchUrl } from './useTicketSearch'

describe('buildTicketSearchUrl', () => {
  it('returns null when neither projectId nor projectSlug is provided', () => {
    expect(
      buildTicketSearchUrl({ query: '', projectId: null, projectSlug: null }),
    ).toBeNull()
  })

  it('uses projectId when only projectId is provided', () => {
    const url = buildTicketSearchUrl({
      query: 'foo',
      projectId: 'p1',
      projectSlug: null,
    })
    expect(url).toContain('projectId=p1')
    expect(url).toContain('q=foo')
    expect(url).not.toContain('projectSlug=')
  })

  it('omits q when query is empty', () => {
    const url = buildTicketSearchUrl({
      query: '',
      projectId: 'p1',
      projectSlug: null,
    })
    expect(url).not.toContain('q=')
    expect(url).toContain('projectId=p1')
  })

  it('prefers projectSlug over projectId when both are provided', () => {
    // Rationale: when the user types `soup#login`, the popover passes the
    // typed slug as projectSlug and the agent's active project as projectId.
    // The slug wins — that's the whole point of the cross-project shorthand.
    const url = buildTicketSearchUrl({
      query: 'login',
      projectId: 'p1',
      projectSlug: 'soupcon-dev',
    })
    expect(url).toContain('projectSlug=soupcon-dev')
    expect(url).not.toContain('projectId=p1')
    expect(url).toContain('q=login')
  })

  it('adds includeDone=0 when includeDone is explicitly false', () => {
    const url = buildTicketSearchUrl({
      query: '',
      projectId: 'p1',
      projectSlug: null,
      includeDone: false,
    })
    expect(url).toContain('includeDone=0')
  })

  it('does not add includeDone when it defaults to true', () => {
    const url = buildTicketSearchUrl({
      query: '',
      projectId: 'p1',
      projectSlug: null,
    })
    expect(url).not.toContain('includeDone=')
  })

  it('URL-encodes special characters in the query', () => {
    const url = buildTicketSearchUrl({
      query: 'foo & bar',
      projectId: 'p1',
      projectSlug: null,
    })
    // URLSearchParams encodes spaces as `+` and `&` as `%26` automatically.
    expect(url).toMatch(/q=foo(\+|%20)%26(\+|%20)bar/)
  })

  it('hits the dedicated /tickets/search route', () => {
    const url = buildTicketSearchUrl({
      query: '',
      projectId: 'p1',
      projectSlug: null,
    })
    expect(url).toStartWith('/tickets/search?')
  })
})
