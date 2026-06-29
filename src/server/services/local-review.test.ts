import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { config } from '@/server/config'
import { _LOCAL_REVIEW_INTERNALS_FOR_TEST, checkCodeRabbitAuth, runLocalCodeReview } from './local-review'

const { parseReviewFindings, evaluateGate, parseJsonLines, kiloSlashCommandArgs, kiloPromptFallbackArgs, execReviewCli, getReviewRun, updateReviewFindingState, trimIncompleteUtf8End, trimIncompleteUtf8Start, validateReviewRepoPath, validateReviewRepoPathWithAllowedRoots, isPathInsideOrEqual } = _LOCAL_REVIEW_INTERNALS_FOR_TEST
const originalPath = process.env.PATH
const originalArtifactDir = config.codeReview.artifactDir
const originalAllowedRepoRoots = [...config.codeReview.allowedRepoRoots]
const originalReviewCliPath = process.env.HIVEKEEP_REVIEW_CLI_PATH
const mutableCodeReviewConfig = config.codeReview as { artifactDir: string; allowedRepoRoots: string[]; maxOutputBytes: number }

afterEach(() => {
  process.env.PATH = originalPath
  if (originalReviewCliPath === undefined) delete process.env.HIVEKEEP_REVIEW_CLI_PATH
  else process.env.HIVEKEEP_REVIEW_CLI_PATH = originalReviewCliPath
  mutableCodeReviewConfig.artifactDir = originalArtifactDir
  mutableCodeReviewConfig.allowedRepoRoots = [...originalAllowedRepoRoots]
})

function makeFakeBin(name: string, body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'hivekeep-local-review-test-'))
  writeFakeBin(root, name, body)
  process.env.PATH = `${root}:${originalPath ?? ''}`
  mutableCodeReviewConfig.allowedRepoRoots = [root]
  return root
}

function writeFakeBin(root: string, name: string, body: string): string {
  mkdirSync(root, { recursive: true })
  const bin = join(root, name)
  writeFileSync(bin, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(bin, 0o755)
  return bin
}

function initGitRepo(path: string): void {
  mkdirSync(path, { recursive: true })
  const result = Bun.spawnSync(['git', '-C', path, 'init'], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
}

describe('local-review repo validation', () => {
  it('allows a workspace-contained Git repo by default', () => {
    const root = mkdtempSync(join(tmpdir(), 'hivekeep-local-review-contained-'))
    try {
      const repo = join(root, 'workspace', 'repo')
      initGitRepo(repo)
      expect(validateReviewRepoPath(repo, join(root, 'workspace'))).toBe(realpathSync(repo))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('allows a Git repo under a configured allowed root outside the workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'hivekeep-local-review-allowed-root-'))
    try {
      const workspace = join(root, 'workspace')
      const repo = join(root, 'allowed', 'repo')
      mkdirSync(workspace, { recursive: true })
      initGitRepo(repo)
      mutableCodeReviewConfig.allowedRepoRoots = [join(root, 'allowed')]
      expect(validateReviewRepoPath(repo, workspace)).toBe(realpathSync(repo))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses supplied effective allowed roots for settings overrides', () => {
    const root = mkdtempSync(join(tmpdir(), 'hivekeep-local-review-effective-root-'))
    try {
      const workspace = join(root, 'workspace')
      const repo = join(root, 'settings-allowed', 'repo')
      mkdirSync(workspace, { recursive: true })
      initGitRepo(repo)
      mutableCodeReviewConfig.allowedRepoRoots = []
      expect(validateReviewRepoPathWithAllowedRoots(repo, workspace, [join(root, 'settings-allowed')])).toBe(realpathSync(repo))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a symlink escape after resolving realpaths', () => {
    const root = mkdtempSync(join(tmpdir(), 'hivekeep-local-review-symlink-'))
    try {
      const workspace = join(root, 'workspace')
      const outsideRepo = join(root, 'outside', 'repo')
      mkdirSync(workspace, { recursive: true })
      initGitRepo(outsideRepo)
      const link = join(workspace, 'repo-link')
      symlinkSync(outsideRepo, link)
      expect(() => validateReviewRepoPath(link, workspace)).toThrow('repo_path must resolve inside')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects non-Git directories inside allowed roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'hivekeep-local-review-non-git-'))
    try {
      const repo = join(root, 'workspace', 'not-git')
      mkdirSync(repo, { recursive: true })
      expect(() => validateReviewRepoPath(repo, join(root, 'workspace'))).toThrow('repo_path must be a Git repository')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects paths outside workspace and configured allowed roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'hivekeep-local-review-outside-'))
    try {
      const workspace = join(root, 'workspace')
      const repo = join(root, 'outside', 'repo')
      mkdirSync(workspace, { recursive: true })
      initGitRepo(repo)
      expect(() => validateReviewRepoPath(repo, workspace)).toThrow('repo_path must resolve inside')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses separator-safe containment checks', () => {
    expect(isPathInsideOrEqual('/tmp/work', '/tmp/work')).toBe(true)
    expect(isPathInsideOrEqual('/tmp/work', '/tmp/work/repo')).toBe(true)
    expect(isPathInsideOrEqual('/tmp/work', '/tmp/workspace/repo')).toBe(false)
  })
})

describe('local-review parsing', () => {
  it('parses JSON-line CodeRabbit findings', () => {
    const raw = [
      JSON.stringify({ type: 'finding', severity: 'critical', title: 'SQL injection', message: 'Use parameters', file: 'src/db.ts', line: 12, confidence: 'high' }),
      JSON.stringify({ event: 'complete', findings: [{ severity: 'minor', title: 'Naming', path: 'src/a.ts' }] }),
    ].join('\n')
    const findings = parseReviewFindings('coderabbit', raw)
    expect(findings).toHaveLength(2)
    expect(findings[0]).toMatchObject({ provider: 'coderabbit', severity: 'critical', file: 'src/db.ts', line: 12, confidence: 'high' })
    expect(findings[1]).toMatchObject({ severity: 'minor', file: 'src/a.ts' })
  })

  it('parses pretty-printed whole JSON objects before JSONL fallback', () => {
    const raw = JSON.stringify({ findings: [{ severity: 'major', title: 'Pretty', file: 'src/pretty.ts', line: 7 }] }, null, 2)
    const events = parseJsonLines(raw)
    expect(events).toHaveLength(1)
    expect(parseReviewFindings('kilo', raw)[0]).toMatchObject({ severity: 'major', title: 'Pretty', file: 'src/pretty.ts' })
  })

  it('ignores non-json log lines while keeping valid JSON events', () => {
    const events = parseJsonLines('hello\n{"type":"finding","title":"x"}\nnot json')
    expect(events).toHaveLength(1)
  })

  it('parses Kilo slash-command findings from nested results', () => {
    const findings = parseReviewFindings('kilo', JSON.stringify({ findings: [{ severity: 'high', title: 'Race', description: 'Shared state', location: { path: 'src/race.ts', line: '5' } }] }))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ provider: 'kilo', severity: 'major', file: 'src/race.ts', line: 5 })
  })

  it('does not duplicate nested finding containers or parse candidate string fields twice', () => {
    const raw = JSON.stringify({
      type: 'finding',
      severity: 'major',
      title: 'Parent container',
      message: '| severity | title | file |\n|---|---|---|\n| high | Nested table | src/table.ts |',
      findings: [{ severity: 'minor', title: 'Child finding', file: 'src/child.ts' }],
    })
    const findings = parseReviewFindings('kilo', raw)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ severity: 'minor', title: 'Child finding', file: 'src/child.ts' })
  })

  it('parses CodeRabbit agent findings with fileName and codegenInstructions fields', () => {
    const findings = parseReviewFindings('coderabbit', JSON.stringify({ type: 'finding', severity: 'major', fileName: 'src/review.ts', codegenInstructions: 'Fix this path' }))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ provider: 'coderabbit', severity: 'major', file: 'src/review.ts', title: 'Fix this path' })
  })

  it('parses Kilo JSON event text containing a Markdown finding table', () => {
    const raw = JSON.stringify({
      type: 'text',
      text: '| severity | title | message | file | line | confidence |\n|---|---|---|---|---:|---|\n| high | Missing guard | Add validation | src/a.ts | 42 | high |',
    })
    const findings = parseReviewFindings('kilo', raw)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ provider: 'kilo', severity: 'major', title: 'Missing guard', file: 'src/a.ts', line: 42, confidence: 'high' })
  })

  it('streams large CLI output into capped head/tail buffers', async () => {
    const root = makeFakeBin('noisy-reviewer', `
python3 - <<'PY'
print('HEAD-FINDING {"type":"finding","severity":"minor","title":"head"}')
print('x' * 200000)
print('TAIL-FINDING {"type":"finding","severity":"major","title":"tail"}')
PY
`)
    try {
      mutableCodeReviewConfig.artifactDir = join(root, 'artifacts')
      const originalMax = config.codeReview.maxOutputBytes
      ;(config.codeReview as { maxOutputBytes: number }).maxOutputBytes = 4096
      const result = await execReviewCli('noisy-reviewer', [], root, 1000)
      ;(config.codeReview as { maxOutputBytes: number }).maxOutputBytes = originalMax
      expect(result.stdout).toContain('HEAD-FINDING')
      expect(result.stdout).toContain('TAIL-FINDING')
      expect(result.stdout).toContain('truncated')
      expect(result.stdout.length).toBeLessThan(9000)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('Kilo local-review adapter', () => {
  it('builds the documented slash-command invocation before prompt fallback', () => {
    expect(kiloSlashCommandArgs({ repoPath: '/repo', base: 'origin/main' })).toEqual(['run', '--format', 'json', '--auto', '--dir', '/repo', '/local-review origin/main'])
    expect(kiloSlashCommandArgs({ repoPath: '/repo', baseCommit: 'abc123' })).toEqual(['run', '--format', 'json', '--auto', '--dir', '/repo', '/local-review abc123'])
    expect(kiloSlashCommandArgs({ repoPath: '/repo', head: 'working tree' })).toEqual(['run', '--format', 'json', '--auto', '--dir', '/repo', '/local-review-uncommitted'])
    expect(kiloPromptFallbackArgs({ repoPath: '/repo', base: 'origin/main' }).at(-1)).toContain('dedicated local code reviewer')
  })

  it('records slash-command adapter mode in Kilo results', async () => {
    const root = makeFakeBin('kilo', `
if [[ "$1" == "--version" ]]; then echo "7.3.44"; exit 0; fi
if [[ "$1" == "auth" ]]; then echo 'Kilo Gateway credential active'; exit 0; fi
if [[ "$1" == "config" ]]; then echo 'not configured optional integration'; exit 1; fi
if [[ "$1" == "run" && "$7" == /local-review* ]]; then echo '{"findings":[{"severity":"minor","title":"Kilo nit","file":"src/kilo.ts"}]}'; exit 0; fi
echo "unexpected args: $*" >&2
exit 1
`)
    try {
      initGitRepo(join(root, 'repo'))
      const result = await runLocalCodeReview({ repoPath: join(root, 'repo'), provider: 'kilo', base: 'origin/main', mode: 'advisory', timeoutMs: 1000 })
      expect(result.results[0]).toMatchObject({ provider: 'kilo', status: 'succeeded', localReviewMode: 'slash-command' })
      expect(result.findings[0]).toMatchObject({ provider: 'kilo', severity: 'minor', file: 'src/kilo.ts' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to prompt mode only when Kilo slash command fails', async () => {
    const root = makeFakeBin('kilo', `
if [[ "$1" == "--version" ]]; then echo "7.3.44"; exit 0; fi
if [[ "$1" == "auth" ]]; then echo 'Kilo Gateway credential active'; exit 0; fi
if [[ "$1" == "config" ]]; then echo 'ok'; exit 0; fi
if [[ "$1" == "run" && "$7" == /local-review* ]]; then echo 'slash failed' >&2; exit 1; fi
if [[ "$1" == "run" ]]; then echo '{"findings":[{"severity":"major","title":"Fallback finding","file":"src/fallback.ts"}]}'; exit 0; fi
exit 1
`)
    try {
      initGitRepo(join(root, 'repo'))
      const result = await runLocalCodeReview({ repoPath: join(root, 'repo'), provider: 'kilo', base: 'origin/main', mode: 'advisory', timeoutMs: 1000 })
      expect(result.results[0]).toMatchObject({ provider: 'kilo', status: 'succeeded', localReviewMode: 'prompt-fallback' })
      expect(result.results[0]?.rawOutput).toContain('slash-command local review failed')
      expect(result.findings[0]).toMatchObject({ provider: 'kilo', severity: 'major', file: 'src/fallback.ts' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not fall back to prompt mode after a timed-out slash command', async () => {
    const root = makeFakeBin('kilo', `
if [[ "$1" == "--version" ]]; then echo "7.3.44"; exit 0; fi
if [[ "$1" == "auth" ]]; then echo 'Kilo Gateway credential active'; exit 0; fi
if [[ "$1" == "config" ]]; then echo 'ok'; exit 0; fi
if [[ "$1" == "run" && "$7" == /local-review* ]]; then sleep 1; echo '{"findings":[{"severity":"major","title":"late","file":"src/late.ts"}]}'; exit 0; fi
if [[ "$1" == "run" ]]; then echo '{"findings":[{"severity":"critical","title":"should not run","file":"src/fallback.ts"}]}'; exit 0; fi
exit 1
`)
    try {
      initGitRepo(join(root, 'repo'))
      const result = await runLocalCodeReview({ repoPath: join(root, 'repo'), provider: 'kilo', base: 'origin/main', mode: 'advisory', timeoutMs: 50 })
      expect(result.results[0]).toMatchObject({ provider: 'kilo', status: 'failed', localReviewMode: 'slash-command' })
      expect(result.results[0]?.error).toContain('timed out')
      expect(result.results[0]?.rawOutput).not.toContain('should not run')
      expect(result.findings).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('local-review gating', () => {
  it('blocks major/critical findings only in blocking mode', () => {
    const findings = parseReviewFindings('coderabbit', JSON.stringify({ findings: [{ severity: 'major', title: 'Bug' }] }))
    expect(evaluateGate(findings, 'blocking')).toBe(true)
    expect(evaluateGate(findings, 'advisory')).toBe(false)
  })

  it('allows advisory/no high severity findings', () => {
    const findings = parseReviewFindings('coderabbit', JSON.stringify({ findings: [{ severity: 'minor', title: 'Nit' }] }))
    expect(evaluateGate(findings, 'blocking')).toBe(false)
  })

  it('ignores fixed and ignored major findings when evaluating blocking gates', () => {
    const findings = parseReviewFindings('coderabbit', JSON.stringify({ findings: [{ severity: 'major', title: 'Fixed' }, { severity: 'critical', title: 'Ignored' }, { severity: 'minor', title: 'Open' }] }))
    findings[0]!.state = 'fixed'
    findings[1]!.state = 'ignored'
    expect(evaluateGate(findings, 'blocking')).toBe(false)
  })
})

describe('local-review CLI readiness', () => {
  it('finds reviewer CLIs on fallback PATH entries when launchd provides a minimal PATH', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hivekeep-local-review-fallback-path-'))
    try {
      const fallbackBin = join(root, 'fallback-bin')
      writeFakeBin(fallbackBin, 'cr', `
if [[ "$1" == "--version" ]]; then echo "0.6.4"; exit 0; fi
if [[ "$1" == "auth" ]]; then echo '{"authenticated":true}'; exit 0; fi
if [[ "$1" == "doctor" ]]; then echo 'doctor ok'; exit 0; fi
exit 1
`)
      process.env.PATH = '/usr/bin:/bin'
      process.env.HIVEKEEP_REVIEW_CLI_PATH = fallbackBin
      const status = await checkCodeRabbitAuth(root, { PATH: '/usr/bin:/bin' })
      expect(status).toMatchObject({ provider: 'coderabbit', installed: true, authenticated: true, version: '0.6.4', localReviewMode: 'native' })
      expect(status.error).toBeUndefined()
    } finally {
      delete process.env.HIVEKEEP_REVIEW_CLI_PATH
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('local-review artifacts', () => {
  it('persists finalized artifact paths and provider metadata', async () => {
    const root = makeFakeBin('cr', `
if [[ "$1" == "--version" ]]; then echo "0.0.0-test"; exit 0; fi
if [[ "$1" == "auth" ]]; then echo '{"authenticated":true}'; exit 0; fi
if [[ "$1" == "doctor" ]]; then echo 'doctor ok'; exit 0; fi
if [[ "$1" == "review" ]]; then echo '{"type":"finding","severity":"minor","title":"Nit","file":"src/a.ts"}'; exit 0; fi
exit 1
`)
    try {
      initGitRepo(join(root, 'repo'))
      mutableCodeReviewConfig.artifactDir = join(root, 'artifacts')
      const result = await runLocalCodeReview({ repoPath: join(root, 'repo'), provider: 'coderabbit', mode: 'advisory', timeoutMs: 1000 })
      expect(result.artifactPath.endsWith(`${result.id}.json`)).toBe(true)
      const saved = JSON.parse(readFileSync(result.artifactPath, 'utf8'))
      expect(saved.artifactPath).toBe(result.artifactPath)
      expect(saved.results[0].artifactPath).toBe(result.artifactPath)
      expect(saved.results[0]).toMatchObject({ provider: 'coderabbit', repoPath: realpathSync(join(root, 'repo')), status: 'succeeded' })
      expect(saved.findings[0]).toMatchObject({ provider: 'coderabbit', severity: 'minor', file: 'src/a.ts', state: 'open' })
      const updated = updateReviewFindingState(result.id, saved.findings[0].id, 'fixed', 'covered by test')
      expect(updated.findings[0]).toMatchObject({ state: 'fixed', stateNote: 'covered by test' })
      expect(updated.blocked).toBe(false)
      expect(getReviewRun(result.id)?.findings[0]).toMatchObject({ state: 'fixed' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves UTF-8 boundaries while trimming capped output edges', () => {
    const emoji = new TextEncoder().encode('abc😀')
    expect(new TextDecoder().decode(trimIncompleteUtf8End(emoji.slice(0, 5)))).toBe('abc')
    expect(new TextDecoder().decode(trimIncompleteUtf8Start(emoji.slice(4)))).toBe('')
    expect(new TextDecoder().decode(trimIncompleteUtf8Start(emoji))).toBe('abc😀')
  })

  it('reports all-skipped advisory runs as skipped and fails closed on blocking readiness errors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hivekeep-local-review-empty-path-'))
    process.env.PATH = root
    writeFakeBin(root, 'cr', 'exit 127')
    writeFakeBin(root, 'coderabbit', 'exit 127')
    mutableCodeReviewConfig.allowedRepoRoots = [root]
    initGitRepo(join(root, 'repo'))
    try {
      mutableCodeReviewConfig.artifactDir = join(root, 'artifacts')
      const advisory = await runLocalCodeReview({ repoPath: join(root, 'repo'), provider: 'coderabbit', mode: 'advisory', timeoutMs: 1000 })
      expect(advisory.blocked).toBe(false)
      expect(advisory.status).toBe('skipped')
      expect(advisory.results[0]).toMatchObject({ status: 'skipped', blocked: false })

      const blocking = await runLocalCodeReview({ repoPath: join(root, 'repo'), provider: 'coderabbit', mode: 'blocking', timeoutMs: 1000 })
      expect(blocking.blocked).toBe(false)
      expect(blocking.status).toBe('failed')
      expect(blocking.results[0]).toMatchObject({ status: 'failed', blocked: false })
      expect(blocking.results[0]?.error).toContain('CodeRabbit CLI not found')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
