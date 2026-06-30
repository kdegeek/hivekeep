import { describe, expect, it } from 'bun:test'
import { hasAgentsResponse } from '@/client/pages/reviewer-agents/ReviewerAgentsPage'

const baseChecklist = {
  id: 'coderabbit-default-review',
  reviewerAgentId: 'coderabbit-reviewer',
  title: 'Checklist',
  description: 'Checklist description',
  memoryTags: ['reviewer:coderabbit'],
  instructionTags: ['focus:tests'],
  items: [],
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const baseAuth = {
  provider: 'coderabbit',
  displayName: 'CodeRabbit',
  installed: false,
  authenticated: null,
}

const baseAgent = {
  id: 'coderabbit-reviewer',
  name: 'CodeRabbit Reviewer',
  provider: 'coderabbit',
  providerName: 'CodeRabbit',
  adapterMode: 'native',
  description: 'Review code locally.',
  defaultReviewMode: 'advisory',
  defaultGate: 'advisory',
  focusAreas: ['tests'],
  checklistIds: ['coderabbit-default-review'],
  memoryTags: ['reviewer:coderabbit'],
  instructionTags: ['reviewer-agent'],
  auth: baseAuth,
  recentRuns: [],
  checklists: [baseChecklist],
}

describe('hasAgentsResponse', () => {
  it('accepts the reviewer agents API shape with role-only remediation targets', () => {
    expect(hasAgentsResponse({
      agents: [{
        ...baseAgent,
        remediationTargets: [
          { role: 'developer', label: 'Assign to developer agent', reason: 'Implementation and test remediation' },
          { role: 'security', label: 'Escalate to security reviewer', reason: 'Security-sensitive findings' },
        ],
      }],
    })).toBe(true)
  })

  it('rejects invalid agents payloads defensively', () => {
    expect(hasAgentsResponse({ reviewerAgents: [] })).toBe(false)
    expect(hasAgentsResponse({ agents: [{ ...baseAgent, remediationTargets: [{ role: 'developer' }] }] })).toBe(false)
  })
})
