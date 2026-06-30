import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { tmpdir } from 'os'
import { config } from '@/server/config'
import {
  getReviewerAgentDefinition,
  listReviewerAgents,
  listReviewerChecklists,
  reviewerAgentIdForProvider,
  runReviewerAgentReview,
  updateReviewerChecklist,
} from './reviewer-agents'

const originalPath = process.env.PATH
const originalArtifactDir = config.codeReview.artifactDir
const originalAllowedRepoRoots = [...config.codeReview.allowedRepoRoots]
const mutableCodeReviewConfig = config.codeReview as { artifactDir: string; allowedRepoRoots: string[] }

afterEach(() => {
  process.env.PATH = originalPath
  mutableCodeReviewConfig.artifactDir = originalArtifactDir
  mutableCodeReviewConfig.allowedRepoRoots = [...originalAllowedRepoRoots]
})

function makeFakeBin(name: string, body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'hivekeep-reviewer-agent-test-'))
  const bin = join(root, name)
  writeFileSync(bin, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(bin, 0o755)
  process.env.PATH = `${root}:${originalPath ?? ''}`
  return root
}

describe('reviewer agent definitions and knowledge', () => {
  it('models CodeRabbit and Kilo Code as stable first-class reviewer agents', () => {
    const coderabbit = getReviewerAgentDefinition('coderabbit-reviewer')
    const kilo = getReviewerAgentDefinition('kilo-code-reviewer')
    expect(coderabbit).toMatchObject({ provider: 'coderabbit', name: 'CodeRabbit Reviewer', adapterMode: 'native' })
    expect(kilo).toMatchObject({ provider: 'kilo', name: 'Kilo Code Reviewer', adapterMode: 'slash-command' })
    expect(reviewerAgentIdForProvider('coderabbit')).toBe('coderabbit-reviewer')
    expect(reviewerAgentIdForProvider('kilo')).toBe('kilo-code-reviewer')
    expect(coderabbit?.memoryTags).toContain('reviewer:coderabbit')
    expect(kilo?.instructionTags).toContain('kilo-slash-command')
    expect(coderabbit?.remediationTargets).toEqual([
      { role: 'developer', label: 'Assign to developer agent', reason: 'Implementation and test remediation' },
      { role: 'security', label: 'Escalate to security reviewer', reason: 'Security, DevOps, and risk findings' },
    ])
    expect(kilo?.remediationTargets.every((target) => target.agentSlug === undefined)).toBe(true)
  })

  it('seeds and updates reviewer-specific checklists in the JSON knowledge store', () => {
    const root = mkdtempSync(join(tmpdir(), 'hivekeep-reviewer-knowledge-'))
    try {
      mutableCodeReviewConfig.artifactDir = join(root, 'artifacts')
      const initial = listReviewerChecklists('coderabbit-reviewer')
      expect(initial).toHaveLength(1)
      expect(initial[0]?.memoryTags).toContain('reviewer:coderabbit')
      const updated = updateReviewerChecklist(initial[0]!.id, { title: 'Updated CodeRabbit checklist' })
      expect(updated.title).toBe('Updated CodeRabbit checklist')
      expect(listReviewerChecklists('coderabbit-reviewer')[0]?.title).toBe('Updated CodeRabbit checklist')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves relative reviewer-agent repo paths from the supplied workspace root', async () => {
    const root = makeFakeBin('cr', `
if [[ "$1" == "--version" ]]; then echo "0.0.0-test"; exit 0; fi
if [[ "$1" == "auth" ]]; then echo '{"authenticated":true}'; exit 0; fi
if [[ "$1" == "doctor" ]]; then echo 'doctor ok'; exit 0; fi
exit 1
`)
    try {
      const kilo = join(root, 'kilo')
      writeFileSync(kilo, `#!/usr/bin/env bash\nexit 127\n`)
      chmodSync(kilo, 0o755)
      const repo = join(root, 'repo')
      mkdirSync(repo, { recursive: true })
      const gitInit = Bun.spawnSync(['git', '-C', repo, 'init'], { stdout: 'pipe', stderr: 'pipe' })
      if (gitInit.exitCode !== 0) throw new Error(new TextDecoder().decode(gitInit.stderr))
      mutableCodeReviewConfig.allowedRepoRoots = []
      mutableCodeReviewConfig.artifactDir = join(root, 'artifacts')
      const previousCwd = process.cwd()
      process.chdir(tmpdir())
      try {
        const agents = await listReviewerAgents(basename(repo), undefined, root)
        expect(agents.find((agent) => agent.id === 'coderabbit-reviewer')?.auth.installed).toBe(true)
      } finally {
        process.chdir(previousCwd)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('maps reviewer-agent runs back to provider artifacts and recent summaries', async () => {
    const root = makeFakeBin('cr', `
if [[ "$1" == "--version" ]]; then echo "0.0.0-test"; exit 0; fi
if [[ "$1" == "auth" ]]; then echo '{"authenticated":true}'; exit 0; fi
if [[ "$1" == "doctor" ]]; then echo 'doctor ok'; exit 0; fi
if [[ "$1" == "review" ]]; then echo '{"type":"finding","severity":"major","title":"Reviewer finding","file":"src/reviewer.ts"}'; exit 0; fi
exit 1
`)
    try {
      const kilo = join(root, 'kilo')
      writeFileSync(kilo, `#!/usr/bin/env bash\nexit 127\n`)
      chmodSync(kilo, 0o755)
      const repo = join(root, 'repo')
      mkdirSync(repo, { recursive: true })
      const gitInit = Bun.spawnSync(['git', '-C', repo, 'init'], { stdout: 'pipe', stderr: 'pipe' })
      if (gitInit.exitCode !== 0) throw new Error(new TextDecoder().decode(gitInit.stderr))
      mutableCodeReviewConfig.allowedRepoRoots = [root]
      mutableCodeReviewConfig.artifactDir = join(root, 'artifacts')
      const run = await runReviewerAgentReview({ reviewerAgentId: 'coderabbit-reviewer', repoPath: repo, mode: 'blocking', timeoutMs: 1000 })
      expect(run.blocked).toBe(true)
      expect(run.results[0]).toMatchObject({ provider: 'coderabbit', localReviewMode: 'native' })
      const agents = await listReviewerAgents(repo)
      const coderabbit = agents.find((agent) => agent.id === 'coderabbit-reviewer')
      expect(coderabbit?.latestRun?.id).toBe(run.id)
      expect(coderabbit?.checklists[0]?.id).toBe('coderabbit-default-review')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
