import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { config } from '@/server/config'
import {
  checkCodeRabbitAuth,
  checkKiloAuth,
  listReviewRuns,
  runLocalCodeReview,
  updateReviewFindingState,
  type LocalReviewAdapterMode,
  type ReviewFindingState,
  type ReviewMode,
  type ReviewProvider,
  type ReviewProviderStatus,
  type ReviewRunSummary,
} from '@/server/services/local-review'

export type ReviewerAgentId = 'coderabbit-reviewer' | 'kilo-code-reviewer'

export interface ReviewerChecklistItem {
  id: string
  label: string
  description?: string
  required: boolean
  defaultState: 'unchecked' | 'checked' | 'needs-decision'
}

export interface ReviewerChecklist {
  id: string
  reviewerAgentId: ReviewerAgentId
  title: string
  description: string
  memoryTags: string[]
  instructionTags: string[]
  items: ReviewerChecklistItem[]
  updatedAt: string
}

export interface ReviewerAgentDefinition {
  id: ReviewerAgentId
  name: string
  provider: ReviewProvider
  providerName: string
  adapterMode: LocalReviewAdapterMode
  description: string
  defaultReviewMode: ReviewMode
  defaultGate: 'advisory' | 'blocking-on-major-critical'
  focusAreas: string[]
  checklistIds: string[]
  memoryTags: string[]
  instructionTags: string[]
  remediationTargets: Array<{ agentSlug: string; label: string; reason: string }>
}

export interface ReviewerAgent extends ReviewerAgentDefinition {
  auth: ReviewProviderStatus
  recentRuns: ReviewRunSummary[]
  latestRun?: ReviewRunSummary
  checklists: ReviewerChecklist[]
}

export interface ReviewerKnowledgeStore {
  version: 1
  checklists: ReviewerChecklist[]
}

const now = () => new Date().toISOString()

const REVIEWER_DEFINITIONS: ReviewerAgentDefinition[] = [
  {
    id: 'coderabbit-reviewer',
    name: 'CodeRabbit Reviewer',
    provider: 'coderabbit',
    providerName: 'CodeRabbit',
    adapterMode: 'native',
    description: 'Dedicated pre-commit/pre-PR reviewer backed by the CodeRabbit CLI agent flow.',
    defaultReviewMode: config.codeReview.defaultMode,
    defaultGate: config.codeReview.defaultMode === 'blocking' ? 'blocking-on-major-critical' : 'advisory',
    focusAreas: ['PR-quality comments', 'correctness regressions', 'maintainability', 'tests', 'security-sensitive changes'],
    checklistIds: ['coderabbit-default-review'],
    memoryTags: ['reviewer:coderabbit', 'local-review', 'pre-pr-gate'],
    instructionTags: ['reviewer-agent', 'coderabbit-cli', 'gate:major-critical'],
    remediationTargets: [
      { agentSlug: 'hiro', label: 'Assign fix to Hiro', reason: 'Implementation and test remediation' },
      { agentSlug: 'kaito', label: 'Escalate to Kaito', reason: 'Security, DevOps, and risk findings' },
    ],
  },
  {
    id: 'kilo-code-reviewer',
    name: 'Kilo Code Reviewer',
    provider: 'kilo',
    providerName: 'Kilo Code',
    adapterMode: 'slash-command',
    description: "Dedicated local reviewer backed by Kilo's `/local-review` slash command with prompt fallback visibility.",
    defaultReviewMode: config.codeReview.defaultMode,
    defaultGate: config.codeReview.defaultMode === 'blocking' ? 'blocking-on-major-critical' : 'advisory',
    focusAreas: ['local diff understanding', 'runtime bugs', 'edge cases', 'test gaps', 'integration regressions'],
    checklistIds: ['kilo-default-review'],
    memoryTags: ['reviewer:kilo', 'local-review', 'pre-commit-gate'],
    instructionTags: ['reviewer-agent', 'kilo-slash-command', 'gate:major-critical'],
    remediationTargets: [
      { agentSlug: 'hiro', label: 'Assign fix to Hiro', reason: 'Implementation and test remediation' },
      { agentSlug: 'kaito', label: 'Escalate to Kaito', reason: 'Security, DevOps, and risk findings' },
    ],
  },
]

const SEEDED_CHECKLISTS: ReviewerChecklist[] = [
  {
    id: 'coderabbit-default-review',
    reviewerAgentId: 'coderabbit-reviewer',
    title: 'CodeRabbit pre-PR review checklist',
    description: 'Reusable checklist for CodeRabbit CLI-backed reviews before PR creation.',
    memoryTags: ['reviewer:coderabbit', 'checklist:pre-pr', 'memory:review-guidance'],
    instructionTags: ['focus:actionable-comments', 'focus:tests', 'focus:security'],
    updatedAt: now(),
    items: [
      { id: 'cr-correctness', label: 'Correctness and regression risks', description: 'Flag behavior changes, broken flows, and missing guards.', required: true, defaultState: 'unchecked' },
      { id: 'cr-tests', label: 'Tests and validation coverage', description: 'Check that meaningful tests or validation notes cover touched logic.', required: true, defaultState: 'unchecked' },
      { id: 'cr-security', label: 'Security and secret handling', description: 'Look for token exposure, auth bypasses, unsafe shell/network use, and injection risks.', required: true, defaultState: 'unchecked' },
      { id: 'cr-maintainability', label: 'Maintainability and PR readability', description: 'Prefer actionable comments over style noise; call out confusing seams.', required: false, defaultState: 'unchecked' },
    ],
  },
  {
    id: 'kilo-default-review',
    reviewerAgentId: 'kilo-code-reviewer',
    title: 'Kilo Code local diff checklist',
    description: 'Reusable checklist for Kilo local-review runs before committing or pushing.',
    memoryTags: ['reviewer:kilo', 'checklist:pre-commit', 'memory:review-guidance'],
    instructionTags: ['focus:local-diff', 'focus:edge-cases', 'focus:integration'],
    updatedAt: now(),
    items: [
      { id: 'kilo-diff-scope', label: 'Diff scope and unintended changes', description: 'Confirm the local diff matches the task and does not include accidental edits.', required: true, defaultState: 'unchecked' },
      { id: 'kilo-runtime', label: 'Runtime and integration behavior', description: 'Check imports, route wiring, serialization, and CLI/runtime assumptions.', required: true, defaultState: 'unchecked' },
      { id: 'kilo-tests', label: 'Test and type coverage', description: 'Identify missing service/type coverage or build-only UI regressions.', required: true, defaultState: 'unchecked' },
      { id: 'kilo-remediation', label: 'Remediation handoff clarity', description: 'Ensure findings can be assigned to Hiro/Kaito with enough context.', required: false, defaultState: 'needs-decision' },
    ],
  },
]

function knowledgePath(): string {
  return join(config.codeReview.artifactDir, 'reviewer-knowledge.json')
}

function defaultStore(): ReviewerKnowledgeStore {
  return { version: 1, checklists: SEEDED_CHECKLISTS }
}

function readStore(): ReviewerKnowledgeStore {
  const path = knowledgePath()
  if (!existsSync(path)) return defaultStore()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ReviewerKnowledgeStore>
    if (parsed.version !== 1 || !Array.isArray(parsed.checklists)) return defaultStore()
    return { version: 1, checklists: parsed.checklists }
  } catch {
    return defaultStore()
  }
}

function writeStore(store: ReviewerKnowledgeStore): ReviewerKnowledgeStore {
  const path = knowledgePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  return store
}

export function listReviewerAgentDefinitions(): ReviewerAgentDefinition[] {
  return REVIEWER_DEFINITIONS
}

export function getReviewerAgentDefinition(id: ReviewerAgentId): ReviewerAgentDefinition | undefined {
  return REVIEWER_DEFINITIONS.find((agent) => agent.id === id)
}

export function reviewerAgentIdForProvider(provider: ReviewProvider): ReviewerAgentId {
  return provider === 'coderabbit' ? 'coderabbit-reviewer' : 'kilo-code-reviewer'
}

export function listReviewerChecklists(reviewerAgentId?: ReviewerAgentId): ReviewerChecklist[] {
  const checklists = readStore().checklists
  return reviewerAgentId ? checklists.filter((checklist) => checklist.reviewerAgentId === reviewerAgentId) : checklists
}

export function updateReviewerChecklist(id: string, patch: Partial<Pick<ReviewerChecklist, 'title' | 'description' | 'items' | 'memoryTags' | 'instructionTags'>>): ReviewerChecklist {
  const store = readStore()
  const index = store.checklists.findIndex((checklist) => checklist.id === id)
  if (index < 0) throw new Error(`Reviewer checklist not found: ${id}`)
  const existing = store.checklists[index]!
  const updated: ReviewerChecklist = {
    ...existing,
    ...patch,
    id: existing.id,
    reviewerAgentId: existing.reviewerAgentId,
    updatedAt: now(),
  }
  store.checklists[index] = updated
  writeStore(store)
  return updated
}

export async function listReviewerAgents(repoPath = process.cwd(), env?: Record<string, string | undefined>): Promise<ReviewerAgent[]> {
  const runs = listReviewRuns(20)
  const checklists = listReviewerChecklists()
  return Promise.all(REVIEWER_DEFINITIONS.map(async (definition) => {
    const auth = definition.provider === 'coderabbit' ? await checkCodeRabbitAuth(repoPath, env) : await checkKiloAuth(repoPath, env)
    const recentRuns = runs.filter((run) => run.results.some((result) => result.provider === definition.provider)).slice(0, 5)
    return {
      ...definition,
      auth,
      recentRuns,
      latestRun: recentRuns[0],
      checklists: checklists.filter((checklist) => definition.checklistIds.includes(checklist.id)),
    }
  }))
}

export async function getReviewerAgent(id: ReviewerAgentId, repoPath = process.cwd(), env?: Record<string, string | undefined>): Promise<ReviewerAgent | undefined> {
  const agents = await listReviewerAgents(repoPath, env)
  return agents.find((agent) => agent.id === id)
}

export async function runReviewerAgentReview(input: {
  reviewerAgentId: ReviewerAgentId
  repoPath: string
  base?: string
  baseCommit?: string
  head?: string
  mode?: ReviewMode
  light?: boolean
  timeoutMs?: number
  env?: Record<string, string | undefined>
}): Promise<ReviewRunSummary> {
  const definition = getReviewerAgentDefinition(input.reviewerAgentId)
  if (!definition) throw new Error(`Unknown reviewer agent: ${input.reviewerAgentId}`)
  return runLocalCodeReview({
    repoPath: input.repoPath,
    provider: definition.provider,
    base: input.base,
    baseCommit: input.baseCommit,
    head: input.head,
    mode: input.mode ?? definition.defaultReviewMode,
    light: input.light,
    timeoutMs: input.timeoutMs,
    env: input.env,
  })
}

export function setReviewerFindingState(runId: string, findingId: string, state: ReviewFindingState, note?: string): ReviewRunSummary {
  return updateReviewFindingState(runId, findingId, state, note)
}
