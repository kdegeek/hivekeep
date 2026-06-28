import { mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { randomUUID } from 'crypto'
import { config } from '@/server/config'

export type ReviewProvider = 'coderabbit' | 'kilo'
export type ReviewRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped'
export type ReviewSeverity = 'info' | 'minor' | 'major' | 'critical'
export type ReviewConfidence = 'low' | 'medium' | 'high'
export type ReviewMode = 'advisory' | 'blocking'

export interface ReviewFinding {
  id: string
  provider: ReviewProvider
  severity: ReviewSeverity
  confidence: ReviewConfidence
  title: string
  message: string
  file?: string
  line?: number
  endLine?: number
  ruleId?: string
  raw?: unknown
}

export interface ReviewInput {
  repoPath: string
  provider?: ReviewProvider | 'all'
  base?: string
  baseCommit?: string
  head?: string
  mode?: ReviewMode
  light?: boolean
  taskId?: string
  agentId?: string
  timeoutMs?: number
}

export interface ReviewProviderStatus {
  provider: ReviewProvider
  displayName: string
  installed: boolean
  authenticated: boolean | null
  version?: string
  authStatus?: string
  doctor?: string
  localReviewMode?: 'native' | 'prompt-fallback'
  error?: string
}

export interface ReviewResult {
  id: string
  provider: ReviewProvider
  status: ReviewRunStatus
  startedAt: string
  completedAt?: string
  repoPath: string
  base?: string
  baseCommit?: string
  head?: string
  mode: ReviewMode
  light: boolean
  findings: ReviewFinding[]
  summary: string
  rawOutput?: string
  error?: string
  artifactPath?: string
  blocked: boolean
}

export interface ReviewRunSummary {
  id: string
  status: ReviewRunStatus
  mode: ReviewMode
  blocked: boolean
  results: ReviewResult[]
  findings: ReviewFinding[]
  artifactPath: string
  summary: string
}

export const LOCAL_REVIEW_PROVIDERS: Array<{ id: ReviewProvider; displayName: string; description: string }> = [
  { id: 'coderabbit', displayName: 'CodeRabbit', description: 'CodeRabbit CLI-backed local reviewer (`cr review --agent --light`).' },
  { id: 'kilo', displayName: 'Kilo Code', description: 'Kilo CLI-backed local reviewer using `kilo run --format json --auto` prompt fallback.' },
]

interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined
}

function clampOutput(s: string): string {
  const max = config.codeReview.maxOutputBytes
  if (s.length <= max) return s
  return `[…truncated ${s.length - max} chars from the head…]\n${s.slice(-max)}`
}

export async function execReviewCli(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = config.codeReview.defaultTimeoutMs,
): Promise<ExecResult> {
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn([command, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (err) {
    return { exitCode: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err), timedOut: false }
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, Math.min(timeoutMs, config.codeReview.maxTimeoutMs))
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { exitCode, stdout: clampOutput(stdout), stderr: clampOutput(stderr), timedOut }
  } catch (err) {
    return { exitCode: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err), timedOut }
  } finally {
    clearTimeout(timer)
  }
}

async function firstWorking(names: string[], args: string[], cwd: string): Promise<{ name: string; result: ExecResult } | null> {
  for (const name of names) {
    const result = await execReviewCli(name, args, cwd, 10_000)
    if (result.exitCode !== 127 && !/command not found/i.test(result.stderr)) return { name, result }
  }
  return null
}

export async function listLocalReviewers(repoPath = process.cwd()): Promise<ReviewProviderStatus[]> {
  return [await checkCodeRabbitAuth(repoPath), await checkKiloAuth(repoPath)]
}

export async function checkCodeRabbitAuth(repoPath = process.cwd()): Promise<ReviewProviderStatus> {
  const found = await firstWorking(['cr', 'coderabbit'], ['--version'], repoPath)
  if (!found) return { provider: 'coderabbit', displayName: 'CodeRabbit', installed: false, authenticated: null, error: 'CodeRabbit CLI not found (`cr` or `coderabbit`).' }
  const auth = await execReviewCli(found.name, ['auth', 'status', '--agent'], repoPath, 15_000)
  const doctor = await execReviewCli(found.name, ['doctor'], repoPath, 30_000)
  const authText = [auth.stdout, auth.stderr].filter(Boolean).join('\n').trim()
  const doctorText = [doctor.stdout, doctor.stderr].filter(Boolean).join('\n').trim()
  return {
    provider: 'coderabbit',
    displayName: 'CodeRabbit',
    installed: true,
    authenticated: auth.exitCode === 0,
    version: found.result.stdout.trim() || found.result.stderr.trim(),
    authStatus: authText || undefined,
    doctor: doctorText || undefined,
    localReviewMode: 'native',
    error: auth.exitCode === 0 ? undefined : authText || 'CodeRabbit auth status failed.',
  }
}

export async function checkKiloAuth(repoPath = process.cwd()): Promise<ReviewProviderStatus> {
  const found = await firstWorking(['kilo'], ['--version'], repoPath)
  if (!found) return { provider: 'kilo', displayName: 'Kilo Code', installed: false, authenticated: null, error: 'Kilo CLI not found (`kilo`).' }
  const auth = await execReviewCli('kilo', ['auth', 'list'], repoPath, 15_000)
  const configCheck = await execReviewCli('kilo', ['config', 'check'], repoPath, 15_000)
  const text = [auth.stdout, auth.stderr, configCheck.stdout, configCheck.stderr].filter(Boolean).join('\n').trim()
  const authenticated = auth.exitCode === 0 && /\bcredential(s)?\b|\boauth\b|Kilo Gateway|OpenAI/i.test(text)
  return {
    provider: 'kilo',
    displayName: 'Kilo Code',
    installed: true,
    authenticated,
    version: found.result.stdout.trim() || found.result.stderr.trim(),
    authStatus: text || undefined,
    localReviewMode: 'prompt-fallback',
    error: authenticated ? undefined : text || 'Kilo auth list did not report configured credentials.',
  }
}

export function parseJsonLines(raw: string): unknown[] {
  const trimmedRaw = raw.trim()
  if (trimmedRaw) {
    try {
      const parsed = JSON.parse(trimmedRaw)
      return Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      // Fall through to JSONL/log parsing.
    }
  }

  const events: unknown[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) continue
    try { events.push(JSON.parse(trimmed)) } catch { /* ignore non-json log lines */ }
  }
  if (events.length > 0) return events

  if (trimmedRaw) {
    for (let i = 0; i < trimmedRaw.length; i++) {
      const ch = trimmedRaw[i]
      if (ch !== '{' && ch !== '[') continue
      try {
        const parsed = JSON.parse(trimmedRaw.slice(i))
        return Array.isArray(parsed) ? parsed : [parsed]
      } catch {
        // Try the next `{` or `[` (e.g. skip log prefixes like `[INFO]`).
      }
    }
  }

  return events
}

function severityFrom(value: unknown): ReviewSeverity {
  const s = String(value ?? '').toLowerCase()
  if (['critical', 'blocker', 'security'].includes(s)) return 'critical'
  if (['major', 'high', 'error'].includes(s)) return 'major'
  if (['minor', 'medium', 'warning', 'warn'].includes(s)) return 'minor'
  return 'info'
}

function confidenceFrom(value: unknown): ReviewConfidence {
  const s = String(value ?? '').toLowerCase()
  if (s === 'high') return 'high'
  if (s === 'low') return 'low'
  return 'medium'
}

function findingFromObject(provider: ReviewProvider, obj: Record<string, unknown>, index: number): ReviewFinding | null {
  const title = asString(obj.title) ?? asString(obj.message) ?? asString(obj.body) ?? asString(obj.description) ?? asString(obj.codegenInstructions)
  if (!title) return null
  const loc = (obj.location && typeof obj.location === 'object') ? obj.location as Record<string, unknown> : {}
  return {
    id: asString(obj.id) ?? `${provider}-${index + 1}`,
    provider,
    severity: severityFrom(obj.severity ?? obj.level ?? obj.priority),
    confidence: confidenceFrom(obj.confidence),
    title: title.slice(0, 240),
    message: (asString(obj.message) ?? asString(obj.body) ?? asString(obj.description) ?? title).slice(0, 4000),
    file: asString(obj.file) ?? asString(obj.fileName) ?? asString(obj.path) ?? asString(loc.path) ?? asString(loc.file),
    line: typeof obj.line === 'number' ? obj.line : typeof loc.line === 'number' ? loc.line : undefined,
    endLine: typeof obj.endLine === 'number' ? obj.endLine : typeof loc.endLine === 'number' ? loc.endLine : undefined,
    ruleId: asString(obj.ruleId) ?? asString(obj.rule_id) ?? asString(obj.code),
    raw: obj,
  }
}

function parseEmbeddedJson(provider: ReviewProvider, text: string): ReviewFinding[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const firstJson = Math.min(...['{', '['].map((ch) => {
    const i = trimmed.indexOf(ch)
    return i < 0 ? Number.POSITIVE_INFINITY : i
  }))
  if (!Number.isFinite(firstJson)) return []
  const jsonLike = trimmed.slice(firstJson)
  try {
    return parseReviewFindings(provider, jsonLike)
  } catch {
    return []
  }
}

function parseMarkdownFindingTable(provider: ReviewProvider, text: string): ReviewFinding[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('|') && line.endsWith('|'))
  if (lines.length < 3) return []
  const header = lines[0]!.split('|').map((cell) => cell.trim().toLowerCase()).filter(Boolean)
  const separator = lines[1]!
  if (!header.includes('severity') || !header.includes('title') || !/^[|\s:-]+$/.test(separator)) return []
  const idx = (name: string) => header.indexOf(name)
  return lines.slice(2).map((line, i) => {
    const cells = line.split('|').map((cell) => cell.trim()).filter((_, cellIndex, arr) => cellIndex > 0 && cellIndex < arr.length - 1)
    const get = (name: string) => {
      const index = idx(name)
      return index >= 0 ? cells[index] : undefined
    }
    return findingFromObject(provider, {
      id: `${provider}-table-${i + 1}`,
      severity: get('severity'),
      title: get('title'),
      message: get('message'),
      file: get('file'),
      line: Number(get('line')) || undefined,
      confidence: get('confidence'),
    }, i)
  }).filter((f): f is ReviewFinding => Boolean(f))
}

const FINDING_ARRAY_KEYS = new Set(['findings', 'issues', 'comments', 'diagnostics'])

function isFindingCandidate(obj: Record<string, unknown>): boolean {
  const type = String(obj.type ?? obj.event ?? '').toLowerCase()
  if (type.includes('finding') || type.includes('issue')) return true
  return Boolean(obj.location || obj.file || obj.path || obj.fileName)
}

function isFindingArrayItem(obj: Record<string, unknown>): boolean {
  return Boolean(obj.severity || obj.title || obj.message || obj.body || obj.description || obj.codegenInstructions)
}

export function parseReviewFindings(provider: ReviewProvider, raw: string): ReviewFinding[] {
  const events = parseJsonLines(raw)
  const candidates: Record<string, unknown>[] = []
  const stringFindings: ReviewFinding[] = []
  const seenStrings = new Set<string>()
  const visit = (v: unknown, fromFindingArray = false) => {
    if (Array.isArray(v)) return v.forEach((item) => visit(item, fromFindingArray))
    if (typeof v === 'string') {
      if (seenStrings.has(v)) return
      seenStrings.add(v)
      stringFindings.push(...parseEmbeddedJson(provider, v), ...parseMarkdownFindingTable(provider, v))
      return
    }
    if (!v || typeof v !== 'object') return
    const obj = v as Record<string, unknown>
    if ((fromFindingArray && isFindingArrayItem(obj)) || isFindingCandidate(obj)) candidates.push(obj)
    for (const [key, value] of Object.entries(obj)) {
      visit(value, FINDING_ARRAY_KEYS.has(key))
    }
  }
  events.forEach((event) => visit(event))
  return [
    ...candidates.map((c, i) => findingFromObject(provider, c, i)).filter((f): f is ReviewFinding => Boolean(f)),
    ...stringFindings,
  ]
}

export function evaluateGate(findings: ReviewFinding[], mode: ReviewMode): boolean {
  return mode === 'blocking' && findings.some((f) => f.severity === 'critical' || f.severity === 'major')
}

function summarize(provider: ReviewProvider, findings: ReviewFinding[], status: ReviewRunStatus, err?: string): string {
  if (status === 'skipped') return `${provider} skipped: ${err ?? 'not configured'}`
  if (status === 'failed') return `${provider} failed: ${err ?? 'unknown error'}`
  const counts = findings.reduce<Record<string, number>>((acc, f) => { acc[f.severity] = (acc[f.severity] ?? 0) + 1; return acc }, {})
  return `${provider} completed with ${findings.length} finding(s): critical=${counts.critical ?? 0}, major=${counts.major ?? 0}, minor=${counts.minor ?? 0}, info=${counts.info ?? 0}`
}

function ensureArtifactDir(): string {
  const dir = resolve(config.codeReview.artifactDir)
  mkdirSync(dir, { recursive: true })
  return dir
}

function artifactPathFor(id: string): string {
  return join(ensureArtifactDir(), `${id}.json`)
}

function persistArtifact(path: string, payload: unknown): string {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  return path
}

function resolveReviewProviders(provider?: ReviewProvider | 'all'): ReviewProvider[] {
  if (!provider || provider === 'all') return ['coderabbit', 'kilo']
  if (!LOCAL_REVIEW_PROVIDERS.some((p) => p.id === provider)) {
    throw new Error(`Unknown local review provider: ${provider}. Valid values: coderabbit, kilo, all`)
  }
  return [provider]
}

function resolveReviewMode(mode?: string): ReviewMode {
  const value = mode ?? config.codeReview.defaultMode
  if (value === 'advisory' || value === 'blocking') return value
  throw new Error(`Invalid review mode: ${value}. Valid values: advisory, blocking`)
}

export async function runLocalCodeReview(input: ReviewInput): Promise<ReviewRunSummary> {
  const repoPath = resolve(input.repoPath)
  const mode = resolveReviewMode(input.mode)
  const providers = resolveReviewProviders(input.provider)
  const id = `review-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  const results: ReviewResult[] = []
  for (const provider of providers) {
    results.push(await runOneProvider(provider, { ...input, repoPath, mode, light: input.light ?? true }, id))
  }
  const findings = results.flatMap((r) => r.findings)
  const blocked = evaluateGate(findings, mode)
  const summary = results.map((r) => r.summary).join('\n') + (blocked ? '\nGate: BLOCKED by major/critical findings.' : '\nGate: passed/advisory.')
  const artifactPath = artifactPathFor(id)
  for (const r of results) r.artifactPath = artifactPath
  const run: ReviewRunSummary = { id, status: results.some((r) => r.status === 'failed') ? 'failed' : 'succeeded', mode, blocked, results, findings, artifactPath, summary }
  persistArtifact(artifactPath, run)
  return run
}

async function runOneProvider(provider: ReviewProvider, input: ReviewInput & { repoPath: string; mode: ReviewMode; light: boolean }, runId: string): Promise<ReviewResult> {
  const startedAt = new Date().toISOString()
  const base: ReviewResult = { id: `${runId}-${provider}`, provider, status: 'running', startedAt, repoPath: input.repoPath, base: input.base, baseCommit: input.baseCommit, head: input.head, mode: input.mode, light: input.light, findings: [], summary: '', blocked: false }
  try {
    const status = provider === 'coderabbit' ? await checkCodeRabbitAuth(input.repoPath) : await checkKiloAuth(input.repoPath)
    if (!status.installed || status.authenticated === false) {
      const error = status.error ?? `${provider} is not ready.`
      const statusValue: ReviewRunStatus = input.mode === 'blocking' ? 'failed' : 'skipped'
      return { ...base, status: statusValue, completedAt: new Date().toISOString(), error, summary: summarize(provider, [], statusValue, error), blocked: false }
    }
    const exec = provider === 'coderabbit' ? await runCodeRabbit(input) : await runKilo(input)
    const rawOutput = [exec.stdout, exec.stderr].filter(Boolean).join('\n')
    const findings = parseReviewFindings(provider, rawOutput)
    const failed = exec.timedOut || (exec.exitCode !== 0 && findings.length === 0)
    const statusValue: ReviewRunStatus = failed ? 'failed' : 'succeeded'
    const error = failed
      ? exec.timedOut
        ? `${provider} review timed out`
        : (rawOutput || `${provider} exited ${exec.exitCode}`)
      : undefined
    const blocked = evaluateGate(findings, input.mode)
    return { ...base, status: statusValue, completedAt: new Date().toISOString(), findings, rawOutput, error, summary: summarize(provider, findings, statusValue, error), blocked }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    return { ...base, status: 'failed', completedAt: new Date().toISOString(), error, summary: summarize(provider, [], 'failed', error), blocked: false }
  }
}

async function runCodeRabbit(input: ReviewInput & { repoPath: string; light: boolean }): Promise<ExecResult> {
  const found = await firstWorking(['cr', 'coderabbit'], ['--version'], input.repoPath)
  if (!found) return { exitCode: 127, stdout: '', stderr: 'CodeRabbit CLI not found.', timedOut: false }
  const args = ['review', '--agent', '--dir', input.repoPath]
  if (input.light) args.push('--light')
  if (input.base) args.push('--base', input.base)
  if (input.baseCommit) args.push('--base-commit', input.baseCommit)
  return execReviewCli(found.name, args, input.repoPath, input.timeoutMs)
}

function kiloReviewPrompt(input: ReviewInput): string {
  return `You are Kilo Code acting as a dedicated local code reviewer for Hivekeep. Review the repository changes before push/PR.\nRepo: ${input.repoPath}\nBase: ${input.base ?? input.baseCommit ?? 'merge-base/default'}\nHead: ${input.head ?? 'working tree'}\nReturn JSON lines or a JSON object with findings[]. Each finding should include severity (critical|major|minor|info), title, message, file, line, confidence. Focus on correctness, security, tests, and regressions. Do not modify files.`
}

async function runKilo(input: ReviewInput & { repoPath: string }): Promise<ExecResult> {
  return execReviewCli('kilo', ['run', '--format', 'json', '--auto', '--dir', input.repoPath, kiloReviewPrompt(input)], input.repoPath, input.timeoutMs)
}

export const _LOCAL_REVIEW_INTERNALS_FOR_TEST = { parseReviewFindings, parseJsonLines, evaluateGate, kiloReviewPrompt }
