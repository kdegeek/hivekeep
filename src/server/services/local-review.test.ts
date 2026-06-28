import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { _LOCAL_REVIEW_INTERNALS_FOR_TEST, runLocalCodeReview } from './local-review'

const { parseReviewFindings, evaluateGate, parseJsonLines } = _LOCAL_REVIEW_INTERNALS_FOR_TEST
const originalPath = process.env.PATH

afterEach(() => {
  process.env.PATH = originalPath
})

function makeFakeBin(name: string, body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'hivekeep-local-review-test-'))
  const bin = join(root, name)
  writeFileSync(bin, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(bin, 0o755)
  process.env.PATH = `${root}:${originalPath ?? ''}`
  return root
}

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

  it('parses Kilo prompt fallback findings from nested results', () => {
    const findings = parseReviewFindings('kilo', JSON.stringify({ findings: [{ severity: 'high', title: 'Race', description: 'Shared state', location: { path: 'src/race.ts', line: 5 } }] }))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ provider: 'kilo', severity: 'major', file: 'src/race.ts', line: 5 })
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
      mkdirSync(join(root, 'repo'), { recursive: true })
      const result = await runLocalCodeReview({ repoPath: join(root, 'repo'), provider: 'coderabbit', mode: 'advisory', timeoutMs: 1000 })
      expect(result.artifactPath.endsWith(`${result.id}.json`)).toBe(true)
      const saved = JSON.parse(readFileSync(result.artifactPath, 'utf8'))
      expect(saved.artifactPath).toBe(result.artifactPath)
      expect(saved.results[0].artifactPath).toBe(result.artifactPath)
      expect(saved.results[0]).toMatchObject({ provider: 'coderabbit', repoPath: join(root, 'repo'), status: 'succeeded' })
      expect(saved.findings[0]).toMatchObject({ provider: 'coderabbit', severity: 'minor', file: 'src/a.ts' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports missing CLIs clearly without blocking unless major/critical findings exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hivekeep-local-review-empty-path-'))
    process.env.PATH = root
    mkdirSync(join(root, 'repo'), { recursive: true })
    try {
      const advisory = await runLocalCodeReview({ repoPath: join(root, 'repo'), provider: 'coderabbit', mode: 'advisory', timeoutMs: 1000 })
      expect(advisory.blocked).toBe(false)
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
