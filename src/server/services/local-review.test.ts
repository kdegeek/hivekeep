import { describe, expect, it } from 'bun:test'
import { mkdirSync, readFileSync } from 'fs'
import { _LOCAL_REVIEW_INTERNALS_FOR_TEST, runLocalCodeReview } from './local-review'

const { parseReviewFindings, evaluateGate, parseJsonLines } = _LOCAL_REVIEW_INTERNALS_FOR_TEST

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

  it('ignores non-json log lines while keeping valid JSON events', () => {
    const events = parseJsonLines('hello\n{"type":"finding","title":"x"}\nnot json')
    expect(events).toHaveLength(1)
  })

  it('parses Kilo prompt fallback findings from nested results', () => {
    const findings = parseReviewFindings('kilo', JSON.stringify({ findings: [{ severity: 'high', title: 'Race', description: 'Shared state', location: { path: 'src/race.ts', line: 5 } }] }))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ provider: 'kilo', severity: 'major', file: 'src/race.ts', line: 5 })
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
  it('persists skipped-review artifacts when CLIs are missing/unauthenticated', async () => {
    mkdirSync('/tmp/hivekeep-test/repo', { recursive: true })
    const result = await runLocalCodeReview({ repoPath: '/tmp/hivekeep-test/repo', provider: 'coderabbit', mode: 'advisory', timeoutMs: 1000 })
    expect(result.artifactPath.endsWith(`${result.id}.json`)).toBe(true)
    const saved = JSON.parse(readFileSync(result.artifactPath, 'utf8'))
    expect(saved.id).toBe(result.id)
    expect(saved.results[0].provider).toBe('coderabbit')
  })
})
