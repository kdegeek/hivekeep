import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve, sep } from 'path'
import { randomUUID } from 'crypto'
import { config } from '@/server/config'

export type ReviewProvider = 'coderabbit' | 'kilo'
export type ReviewRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped'
export type ReviewSeverity = 'info' | 'minor' | 'major' | 'critical'
export type ReviewConfidence = 'low' | 'medium' | 'high'
export type ReviewMode = 'advisory' | 'blocking'
export type ReviewFindingState = 'open' | 'fixed' | 'ignored' | 'needs-decision'
export type LocalReviewAdapterMode = 'native' | 'slash-command' | 'prompt-fallback'

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
  state?: ReviewFindingState
  stateNote?: string
  updatedAt?: string
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
  env?: Record<string, string | undefined>
}

export interface ReviewProviderStatus {
  provider: ReviewProvider
  displayName: string
  installed: boolean
  authenticated: boolean | null
  version?: string
  authStatus?: string
  doctor?: string
  localReviewMode?: LocalReviewAdapterMode
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
  localReviewMode?: LocalReviewAdapterMode
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

function normalizeFindingStates<T extends ReviewRunSummary>(run: T): T {
  for (const finding of run.findings) finding.state ??= 'open'
  for (const result of run.results) {
    for (const finding of result.findings) finding.state ??= 'open'
  }
  return run
}

export const LOCAL_REVIEW_PROVIDERS: Array<{ id: ReviewProvider; displayName: string; description: string }> = [
  { id: 'coderabbit', displayName: 'CodeRabbit', description: 'CodeRabbit CLI-backed local reviewer (`cr review --agent --light`).' },
  { id: 'kilo', displayName: 'Kilo Code', description: "Kilo CLI-backed local reviewer using Kilo's `/local-review` slash command via `kilo run --format json --auto`." },
]

interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  localReviewMode?: LocalReviewAdapterMode
}

function mergeExecEnv(extraEnv?: Record<string, string | undefined>): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...process.env, ...extraEnv, NO_COLOR: '1', FORCE_COLOR: '0' })) {
    if (typeof value === 'string') merged[key] = value
  }
  return merged
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const combined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return combined
}

function trimIncompleteUtf8End(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength === 0) return bytes
  let start = bytes.byteLength - 1
  while (start >= 0 && (bytes[start]! & 0xc0) === 0x80) start--
  if (start < 0) return new Uint8Array(0)
  const lead = bytes[start]!
  const expected = lead < 0x80 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 1
  return bytes.byteLength - start >= expected ? bytes : bytes.slice(0, start)
}

function trimIncompleteUtf8Start(bytes: Uint8Array): Uint8Array {
  let start = 0
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start++
  return start === 0 ? bytes : bytes.slice(start)
}

async function readCappedStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ''
  const max = config.codeReview.maxOutputBytes
  const edge = Math.max(1, Math.floor(max / 2))
  const reader = stream.getReader()
  const allChunks: Uint8Array[] = []
  const headChunks: Uint8Array[] = []
  let total = 0
  let headBytes = 0
  let tail = new Uint8Array(0)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value?.byteLength) continue
    total += value.byteLength
    if (total <= max) allChunks.push(value)
    if (headBytes < edge) {
      const remaining = edge - headBytes
      const headSlice = value.slice(0, remaining)
      headChunks.push(headSlice)
      headBytes += headSlice.byteLength
    }
    const combined = new Uint8Array(tail.byteLength + value.byteLength)
    combined.set(tail)
    combined.set(value, tail.byteLength)
    tail = combined.byteLength > edge ? combined.slice(combined.byteLength - edge) : combined
  }
  const decoder = new TextDecoder()
  if (total <= max) return decoder.decode(concatChunks(allChunks))
  const head = decoder.decode(trimIncompleteUtf8End(concatChunks(headChunks)))
  const tailText = decoder.decode(trimIncompleteUtf8Start(tail))
  return `${head}\n[…truncated ${total - max} bytes from the middle…]\n${tailText}`
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined
}

function redactSensitiveOutput(s: string): string {
  return s
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/\b(token|api[_-]?key|secret|password|authorization)(\s*[:=]\s*)([^\s'"`,;]+)/gi, '$1$2[redacted]')
}

function parseOptionalLine(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return undefined
}

export async function execReviewCli(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = config.codeReview.defaultTimeoutMs,
  env?: Record<string, string | undefined>,
): Promise<ExecResult> {
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn([command, ...args], {
      cwd,
      env: mergeExecEnv(env),
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
      readCappedStream(proc.stdout),
      readCappedStream(proc.stderr),
      proc.exited,
    ])
    return { exitCode, stdout, stderr, timedOut }
  } catch (err) {
    return { exitCode: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err), timedOut }
  } finally {
    clearTimeout(timer)
  }
}

async function firstWorking(names: string[], args: string[], cwd: string, env?: Record<string, string | undefined>): Promise<{ name: string; result: ExecResult } | null> {
  for (const name of names) {
    const result = await execReviewCli(name, args, cwd, 10_000, env)
    if (result.exitCode !== 127 && !/command not found/i.test(result.stderr)) return { name, result }
  }
  return null
}

export async function listLocalReviewers(repoPath = process.cwd(), env?: Record<string, string | undefined>): Promise<ReviewProviderStatus[]> {
  return [await checkCodeRabbitAuth(repoPath, env), await checkKiloAuth(repoPath, env)]
}

export async function checkCodeRabbitAuth(repoPath = process.cwd(), env?: Record<string, string | undefined>): Promise<ReviewProviderStatus> {
  const found = await firstWorking(['cr', 'coderabbit'], ['--version'], repoPath, env)
  if (!found) return { provider: 'coderabbit', displayName: 'CodeRabbit', installed: false, authenticated: null, error: 'CodeRabbit CLI not found (`cr` or `coderabbit`).' }
  const auth = await execReviewCli(found.name, ['auth', 'status', '--agent'], repoPath, 15_000, env)
  const doctor = await execReviewCli(found.name, ['doctor'], repoPath, 30_000, env)
  const authText = redactSensitiveOutput([auth.stdout, auth.stderr].filter(Boolean).join('\n').trim())
  const doctorText = redactSensitiveOutput([doctor.stdout, doctor.stderr].filter(Boolean).join('\n').trim())
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

export async function checkKiloAuth(repoPath = process.cwd(), env?: Record<string, string | undefined>): Promise<ReviewProviderStatus> {
  const found = await firstWorking(['kilo'], ['--version'], repoPath, env)
  if (!found) return { provider: 'kilo', displayName: 'Kilo Code', installed: false, authenticated: null, error: 'Kilo CLI not found (`kilo`).' }
  const auth = await execReviewCli('kilo', ['auth', 'list'], repoPath, 15_000, env)
  const configCheck = await execReviewCli('kilo', ['config', 'check'], repoPath, 15_000, env)
  const authText = redactSensitiveOutput([auth.stdout, auth.stderr].filter(Boolean).join('\n').trim())
  const configText = redactSensitiveOutput([configCheck.stdout, configCheck.stderr].filter(Boolean).join('\n').trim())
  const text = [authText, configText].filter(Boolean).join('\n')
  const negativeAuth = /\b(no|not|missing|absent|invalid|expired|unauthorized|unauthenticated)\b.{0,40}\b(credential|credentials|auth|login|provider|account|token|key)s?\b|\bnot logged in\b/i.test(authText)
  const positiveAuth = /\b(Kilo Gateway|OpenAI|oauth)\b|\bcredential(s)?\b.{0,40}\b(active|configured|found|available|connected|present)\b/i.test(authText)
  const authenticated = auth.exitCode === 0 && positiveAuth && !negativeAuth
  return {
    provider: 'kilo',
    displayName: 'Kilo Code',
    installed: true,
    authenticated,
    version: found.result.stdout.trim() || found.result.stderr.trim(),
    authStatus: text || undefined,
    localReviewMode: 'slash-command',
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
    line: parseOptionalLine(obj.line) ?? parseOptionalLine(loc.line),
    endLine: parseOptionalLine(obj.endLine) ?? parseOptionalLine(loc.endLine),
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
  if (!header.includes('severity') || (!header.includes('title') && !header.includes('issue')) || !/^[|\s:-]+$/.test(separator)) return []
  const idx = (name: string) => header.indexOf(name)
  return lines.slice(2).map((line, i) => {
    const cells = line.split('|').map((cell) => cell.trim()).filter((_, cellIndex, arr) => cellIndex > 0 && cellIndex < arr.length - 1)
    const get = (name: string) => {
      const index = idx(name)
      return index >= 0 ? cells[index] : undefined
    }
    const fileLine = get('file:line') ?? get('file')
    const parsedLocation = fileLine?.match(/^(.*):(\d+)$/)
    return findingFromObject(provider, {
      id: `${provider}-table-${i + 1}`,
      severity: get('severity'),
      title: get('title') ?? get('issue'),
      message: get('message') ?? get('issue'),
      file: parsedLocation?.[1] ?? fileLine,
      line: Number(get('line') ?? parsedLocation?.[2]) || undefined,
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
    const entries = Object.entries(obj)
    const hasNestedFindingArray = entries.some(([key, value]) => FINDING_ARRAY_KEYS.has(key) && Array.isArray(value))
    const candidate = (fromFindingArray && isFindingArrayItem(obj)) || isFindingCandidate(obj)
    if (candidate && !hasNestedFindingArray) candidates.push(obj)
    for (const [key, value] of entries) {
      if (candidate && typeof value === 'string') continue
      visit(value, FINDING_ARRAY_KEYS.has(key))
    }
  }
  events.forEach((event) => visit(event))
  return [
    ...candidates.map((c, i) => findingFromObject(provider, c, i)).filter((f): f is ReviewFinding => Boolean(f)),
    ...stringFindings,
  ]
}

function isActiveBlockingFinding(finding: ReviewFinding): boolean {
  return (finding.severity === 'critical' || finding.severity === 'major') && finding.state !== 'fixed' && finding.state !== 'ignored'
}

export function evaluateGate(findings: ReviewFinding[], mode: ReviewMode): boolean {
  return mode === 'blocking' && findings.some(isActiveBlockingFinding)
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
  const dir = ensureArtifactDir()
  if (id.includes('..') || id.includes('/') || id.includes('\\') || id.includes('\0')) {
    throw new Error(`Invalid review run id: ${id}`)
  }
  const path = resolve(join(dir, `${id}.json`))
  if (path !== dir && !path.startsWith(dir + sep)) {
    throw new Error(`Invalid review run id: ${id}`)
  }
  return path
}

function persistArtifact(path: string, payload: unknown): string {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  return path
}

function readReviewRunArtifact(path: string): ReviewRunSummary | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ReviewRunSummary
    if (!parsed?.id || !Array.isArray(parsed.results) || !Array.isArray(parsed.findings)) return null
    return normalizeFindingStates(parsed)
  } catch {
    return null
  }
}

export function getReviewRun(id: string): ReviewRunSummary | null {
  let path: string
  try {
    path = artifactPathFor(id)
  } catch {
    return null
  }
  if (!existsSync(path)) return null
  return readReviewRunArtifact(path)
}

export function listReviewRuns(limit = 20): ReviewRunSummary[] {
  const dir = ensureArtifactDir()
  return readdirSync(dir)
    .filter((name) => name.startsWith('review-') && name.endsWith('.json'))
    .map((name) => readReviewRunArtifact(join(dir, name)))
    .filter((run): run is ReviewRunSummary => Boolean(run))
    .sort((a, b) => b.id.localeCompare(a.id))
    .slice(0, Math.max(1, Math.min(limit, 100)))
}

export function updateReviewFindingState(runId: string, findingId: string, state: ReviewFindingState, note?: string): ReviewRunSummary {
  const run = getReviewRun(runId)
  if (!run) throw new Error(`Review run not found: ${runId}`)
  let touched = false
  const updatedAt = new Date().toISOString()
  const apply = (finding: ReviewFinding) => {
    if (finding.id !== findingId) return
    finding.state = state
    finding.stateNote = note
    finding.updatedAt = updatedAt
    touched = true
  }
  run.findings.forEach(apply)
  run.results.forEach((result) => result.findings.forEach(apply))
  if (!touched) throw new Error(`Review finding not found: ${findingId}`)
  run.blocked = evaluateGate(run.findings, run.mode)
  for (const result of run.results) result.blocked = evaluateGate(result.findings, result.mode)
  persistArtifact(artifactPathFor(runId), run)
  return run
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
  const runStatus: ReviewRunStatus = results.some((r) => r.status === 'failed') ? 'failed' : results.every((r) => r.status === 'skipped') ? 'skipped' : 'succeeded'
  const gateSuffix = blocked
    ? '\nGate: BLOCKED by major/critical findings.'
    : runStatus === 'failed'
      ? '\nGate: FAILED.'
      : '\nGate: passed/advisory.'
  const summary = results.map((r) => r.summary).join('\n') + gateSuffix
  const artifactPath = artifactPathFor(id)
  for (const r of results) r.artifactPath = artifactPath
  const run: ReviewRunSummary = normalizeFindingStates({ id, status: runStatus, mode, blocked, results, findings, artifactPath, summary })
  persistArtifact(artifactPath, run)
  return run
}

async function runOneProvider(provider: ReviewProvider, input: ReviewInput & { repoPath: string; mode: ReviewMode; light: boolean }, runId: string): Promise<ReviewResult> {
  const startedAt = new Date().toISOString()
  const base: ReviewResult = { id: `${runId}-${provider}`, provider, status: 'running', startedAt, repoPath: input.repoPath, base: input.base, baseCommit: input.baseCommit, head: input.head, mode: input.mode, light: input.light, findings: [], summary: '', blocked: false }
  try {
    const status = provider === 'coderabbit' ? await checkCodeRabbitAuth(input.repoPath, input.env) : await checkKiloAuth(input.repoPath, input.env)
    if (!status.installed || status.authenticated === false) {
      const error = status.error ?? `${provider} is not ready.`
      const statusValue: ReviewRunStatus = input.mode === 'blocking' ? 'failed' : 'skipped'
      return { ...base, status: statusValue, completedAt: new Date().toISOString(), error, summary: summarize(provider, [], statusValue, error), blocked: false }
    }
    const exec = provider === 'coderabbit' ? await runCodeRabbit(input) : await runKilo(input)
    const rawOutput = redactSensitiveOutput([exec.stdout, exec.stderr].filter(Boolean).join('\n'))
    const findings = parseReviewFindings(provider, rawOutput)
    const failed = exec.timedOut || (exec.exitCode !== 0 && findings.length === 0)
    const statusValue: ReviewRunStatus = failed ? 'failed' : 'succeeded'
    const error = failed
      ? exec.timedOut
        ? `${provider} review timed out`
        : (rawOutput || `${provider} exited ${exec.exitCode}`)
      : undefined
    const blocked = evaluateGate(findings, input.mode)
    return { ...base, status: statusValue, completedAt: new Date().toISOString(), findings, rawOutput, error, localReviewMode: exec.localReviewMode ?? status.localReviewMode, summary: summarize(provider, findings, statusValue, error), blocked }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    return { ...base, status: 'failed', completedAt: new Date().toISOString(), error: redactSensitiveOutput(error), summary: summarize(provider, [], 'failed', redactSensitiveOutput(error)), blocked: input.mode === 'blocking' }
  }
}

async function runCodeRabbit(input: ReviewInput & { repoPath: string; light: boolean }): Promise<ExecResult> {
  const found = await firstWorking(['cr', 'coderabbit'], ['--version'], input.repoPath, input.env)
  if (!found) return { exitCode: 127, stdout: '', stderr: 'CodeRabbit CLI not found.', timedOut: false }
  const args = ['review', '--agent', '--dir', input.repoPath]
  if (input.light) args.push('--light')
  if (input.base) args.push('--base', input.base)
  if (input.baseCommit) args.push('--base-commit', input.baseCommit)
  const result = await execReviewCli(found.name, args, input.repoPath, input.timeoutMs, input.env)
  return { ...result, localReviewMode: 'native' }
}

function kiloReviewPrompt(input: ReviewInput): string {
  return `You are Kilo Code acting as a dedicated local code reviewer for Hivekeep. Review the repository changes before push/PR.\nRepo: ${input.repoPath}\nBase: ${input.base ?? input.baseCommit ?? 'merge-base/default'}\nHead: ${input.head ?? 'working tree'}\nReturn JSON lines or a JSON object with findings[]. Each finding should include severity (critical|major|minor|info), title, message, file, line, confidence. Focus on correctness, security, tests, and regressions. Do not modify files.`
}

function kiloSlashCommand(input: ReviewInput): '/local-review' | '/local-review-uncommitted' {
  return input.head === 'working tree' && !input.base && !input.baseCommit ? '/local-review-uncommitted' : '/local-review'
}

function kiloSlashCommandBaseArg(input: ReviewInput): string | undefined {
  return input.base ?? input.baseCommit
}

function kiloSlashCommandToken(input: ReviewInput): string {
  const command = kiloSlashCommand(input)
  const baseArg = kiloSlashCommandBaseArg(input)
  return baseArg && command === '/local-review' ? `${command} ${baseArg}` : command
}

function kiloSlashCommandArgs(input: ReviewInput & { repoPath: string }): string[] {
  return ['run', '--format', 'json', '--auto', '--dir', input.repoPath, kiloSlashCommandToken(input)]
}

function kiloPromptFallbackArgs(input: ReviewInput & { repoPath: string }): string[] {
  return ['run', '--format', 'json', '--auto', '--dir', input.repoPath, kiloReviewPrompt(input)]
}

async function runKilo(input: ReviewInput & { repoPath: string }): Promise<ExecResult> {
  const slash = await execReviewCli('kilo', kiloSlashCommandArgs(input), input.repoPath, input.timeoutMs, input.env)
  const slashRaw = [slash.stdout, slash.stderr].filter(Boolean).join('\n')
  if (slash.exitCode === 0 || slash.timedOut || parseReviewFindings('kilo', slashRaw).length > 0) return { ...slash, localReviewMode: 'slash-command' }

  const fallback = await execReviewCli('kilo', kiloPromptFallbackArgs(input), input.repoPath, input.timeoutMs, input.env)
  return {
    ...fallback,
    stdout: fallback.stdout,
    stderr: [`Kilo slash-command local review failed; used prompt fallback.`, slashRaw, fallback.stderr].filter(Boolean).join('\n'),
    localReviewMode: 'prompt-fallback',
  }
}

export const _LOCAL_REVIEW_INTERNALS_FOR_TEST = { parseReviewFindings, parseJsonLines, evaluateGate, kiloReviewPrompt, kiloSlashCommand, kiloSlashCommandArgs, kiloPromptFallbackArgs, listReviewRuns, getReviewRun, updateReviewFindingState, execReviewCli, trimIncompleteUtf8End, trimIncompleteUtf8Start }
