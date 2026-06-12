/**
 * Tests for `buildWorkspaceSearchUrl` — the pure helper of
 * useWorkspaceFileSearch (repo convention: no DOM renderer, hooks stay thin
 * wrappers around setTimeout/setState; the request-sequencing pattern is the
 * same as useTicketSearch).
 */
import { describe, it, expect } from 'bun:test'
import { buildWorkspaceSearchUrl } from './useWorkspaceFileSearch'

describe('buildWorkspaceSearchUrl', () => {
  it('returns null without an agent', () => {
    expect(buildWorkspaceSearchUrl({ agentId: null, query: 'x', limit: 8 })).toBeNull()
  })

  it('builds the scoped search URL', () => {
    const url = buildWorkspaceSearchUrl({ agentId: 'agent-1', query: 'rapport', limit: 8 })
    expect(url).toBe('/agents/agent-1/workspace/search?q=rapport&limit=8')
  })

  it('omits q when empty and clamps the limit', () => {
    const url = buildWorkspaceSearchUrl({ agentId: 'agent-1', query: '', limit: 500 })
    expect(url).toBe('/agents/agent-1/workspace/search?limit=50')
  })

  it('URL-encodes slugs and queries (spaces, accents)', () => {
    const url = buildWorkspaceSearchUrl({ agentId: 'a b', query: 'Rapport final é', limit: 8 })
    expect(url).toContain('/agents/a%20b/')
    expect(url).toContain('q=Rapport+final+%C3%A9')
  })
})
