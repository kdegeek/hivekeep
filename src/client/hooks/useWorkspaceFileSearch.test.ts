/**
 * Tests for `buildWorkspaceSearchUrl` — the pure helper of
 * useWorkspaceFileSearch (repo convention: no DOM renderer, hooks stay thin
 * wrappers around setTimeout/setState; the request-sequencing pattern is the
 * same as useTicketSearch).
 */
import { describe, it, expect } from 'bun:test'
import { buildWorkspaceSearchUrl } from './useWorkspaceFileSearch'

describe('buildWorkspaceSearchUrl', () => {
  it('returns null without a source', () => {
    expect(buildWorkspaceSearchUrl({ source: null, query: 'x', limit: 8 })).toBeNull()
  })

  it('builds the scoped search URL for an agent source', () => {
    const url = buildWorkspaceSearchUrl({ source: { type: 'agent', id: 'agent-1' }, query: 'rapport', limit: 8 })
    expect(url).toBe('/workspace/agent/agent-1/search?q=rapport&limit=8')
  })

  it('omits q when empty and clamps the limit', () => {
    const url = buildWorkspaceSearchUrl({ source: { type: 'agent', id: 'agent-1' }, query: '', limit: 500 })
    expect(url).toBe('/workspace/agent/agent-1/search?limit=50')
  })

  it('URL-encodes ids and queries (spaces, accents)', () => {
    const url = buildWorkspaceSearchUrl({ source: { type: 'folder', id: 'a b' }, query: 'Rapport final é', limit: 8 })
    expect(url).toContain('/workspace/folder/a%20b/')
    expect(url).toContain('q=Rapport+final+%C3%A9')
  })

  it('carries the project worktree as a query param', () => {
    const url = buildWorkspaceSearchUrl({ source: { type: 'project', id: 'p1', worktree: 'wt-2' }, query: 'x', limit: 8 })
    expect(url).toBe('/workspace/project/p1/search?q=x&limit=8&worktree=wt-2')
  })
})
