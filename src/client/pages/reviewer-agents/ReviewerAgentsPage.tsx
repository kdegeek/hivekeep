import { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  ExternalLink,
  GitPullRequest,
  Loader2,
  Play,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  SquarePen,
  XCircle,
} from 'lucide-react'
import { PageHeader } from '@/client/components/layout/PageHeader'
import { Button } from '@/client/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/client/components/ui/card'
import { Badge } from '@/client/components/ui/badge'
import { Input } from '@/client/components/ui/input'
import { Textarea } from '@/client/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/client/components/ui/select'
import { ApiRequestError, api, getErrorMessage, toastError } from '@/client/lib/api'
import { useAuth } from '@/client/hooks/useAuth'
import { cn } from '@/client/lib/utils'

type ReviewProvider = 'coderabbit' | 'kilo'
type ReviewRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped'
type ReviewSeverity = 'info' | 'minor' | 'major' | 'critical'
type ReviewMode = 'advisory' | 'blocking'
type FindingState = 'open' | 'fixed' | 'ignored' | 'needs-decision'
type ReviewerAgentId = 'coderabbit-reviewer' | 'kilo-code-reviewer'

interface ReviewProviderStatus {
  provider: ReviewProvider
  displayName: string
  installed: boolean
  authenticated: boolean | null
  version?: string
  authStatus?: string
  doctor?: string
  localReviewMode?: string
  error?: string
}

interface ReviewFinding {
  id: string
  provider: ReviewProvider
  severity: ReviewSeverity
  confidence: 'low' | 'medium' | 'high'
  title: string
  message: string
  file?: string
  line?: number
  endLine?: number
  ruleId?: string
  state?: FindingState
  stateNote?: string
}

interface ReviewResult {
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
  localReviewMode?: string
  blocked: boolean
}

interface ReviewRunSummary {
  id: string
  status: ReviewRunStatus
  mode: ReviewMode
  blocked: boolean
  results: ReviewResult[]
  findings: ReviewFinding[]
  artifactPath: string
  summary: string
}

interface ReviewerChecklistItem {
  id: string
  label: string
  description?: string
  required: boolean
  defaultState: 'unchecked' | 'checked' | 'needs-decision'
}

interface ReviewerChecklist {
  id: string
  reviewerAgentId: ReviewerAgentId
  title: string
  description: string
  memoryTags: string[]
  instructionTags: string[]
  items: ReviewerChecklistItem[]
  updatedAt: string
}

interface ReviewerAgent {
  id: ReviewerAgentId
  name: string
  provider: ReviewProvider
  providerName: string
  adapterMode: string
  description: string
  defaultReviewMode: ReviewMode
  defaultGate: string
  focusAreas: string[]
  checklistIds: string[]
  memoryTags: string[]
  instructionTags: string[]
  remediationTargets: Array<{ agentSlug: string; label: string; reason: string }>
  auth: ReviewProviderStatus
  recentRuns: ReviewRunSummary[]
  latestRun?: ReviewRunSummary
  checklists: ReviewerChecklist[]
}

interface AgentsResponse { agents: ReviewerAgent[] }
interface RunsResponse { runs: ReviewRunSummary[] }
interface RunResponse { run: ReviewRunSummary }
interface ChecklistResponse { checklist: ReviewerChecklist }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isRemediationTarget(value: unknown): boolean {
  return isRecord(value) && typeof value.agentSlug === 'string' && typeof value.label === 'string' && typeof value.reason === 'string'
}

function isReviewProviderStatus(value: unknown): value is ReviewProviderStatus {
  return isRecord(value)
    && (value.provider === 'coderabbit' || value.provider === 'kilo')
    && typeof value.displayName === 'string'
    && typeof value.installed === 'boolean'
    && (typeof value.authenticated === 'boolean' || value.authenticated === null)
    && isOptionalString(value.version)
    && isOptionalString(value.authStatus)
    && isOptionalString(value.doctor)
    && isOptionalString(value.localReviewMode)
    && isOptionalString(value.error)
}

function isReviewFinding(value: unknown): value is ReviewFinding {
  return isRecord(value)
    && typeof value.id === 'string'
    && (value.provider === 'coderabbit' || value.provider === 'kilo')
    && (value.severity === 'info' || value.severity === 'minor' || value.severity === 'major' || value.severity === 'critical')
    && (value.confidence === 'low' || value.confidence === 'medium' || value.confidence === 'high')
    && typeof value.title === 'string'
    && typeof value.message === 'string'
    && isOptionalString(value.file)
    && (value.line === undefined || typeof value.line === 'number')
    && (value.endLine === undefined || typeof value.endLine === 'number')
    && isOptionalString(value.ruleId)
    && (value.state === undefined || value.state === 'open' || value.state === 'fixed' || value.state === 'ignored' || value.state === 'needs-decision')
    && isOptionalString(value.stateNote)
}

function isReviewResult(value: unknown): value is ReviewResult {
  return isRecord(value)
    && typeof value.id === 'string'
    && (value.provider === 'coderabbit' || value.provider === 'kilo')
    && (value.status === 'queued' || value.status === 'running' || value.status === 'succeeded' || value.status === 'failed' || value.status === 'skipped')
    && typeof value.startedAt === 'string'
    && isOptionalString(value.completedAt)
    && typeof value.repoPath === 'string'
    && isOptionalString(value.base)
    && isOptionalString(value.baseCommit)
    && isOptionalString(value.head)
    && (value.mode === 'advisory' || value.mode === 'blocking')
    && typeof value.light === 'boolean'
    && Array.isArray(value.findings) && value.findings.every(isReviewFinding)
    && typeof value.summary === 'string'
    && isOptionalString(value.rawOutput)
    && isOptionalString(value.error)
    && isOptionalString(value.artifactPath)
    && isOptionalString(value.localReviewMode)
    && typeof value.blocked === 'boolean'
}

function isReviewRunSummary(value: unknown): value is ReviewRunSummary {
  return isRecord(value)
    && typeof value.id === 'string'
    && (value.status === 'queued' || value.status === 'running' || value.status === 'succeeded' || value.status === 'failed' || value.status === 'skipped')
    && (value.mode === 'advisory' || value.mode === 'blocking')
    && typeof value.blocked === 'boolean'
    && Array.isArray(value.results) && value.results.every(isReviewResult)
    && Array.isArray(value.findings) && value.findings.every(isReviewFinding)
    && typeof value.artifactPath === 'string'
    && typeof value.summary === 'string'
}

function isReviewerChecklistItem(value: unknown): value is ReviewerChecklistItem {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.label === 'string'
    && isOptionalString(value.description)
    && typeof value.required === 'boolean'
    && (value.defaultState === 'unchecked' || value.defaultState === 'checked' || value.defaultState === 'needs-decision')
}

function isReviewerChecklist(value: unknown): value is ReviewerChecklist {
  return isRecord(value)
    && typeof value.id === 'string'
    && (value.reviewerAgentId === 'coderabbit-reviewer' || value.reviewerAgentId === 'kilo-code-reviewer')
    && typeof value.title === 'string'
    && typeof value.description === 'string'
    && isStringArray(value.memoryTags)
    && isStringArray(value.instructionTags)
    && Array.isArray(value.items) && value.items.every(isReviewerChecklistItem)
    && typeof value.updatedAt === 'string'
}

function isReviewerAgent(value: unknown): value is ReviewerAgent {
  return isRecord(value)
    && (value.id === 'coderabbit-reviewer' || value.id === 'kilo-code-reviewer')
    && typeof value.name === 'string'
    && (value.provider === 'coderabbit' || value.provider === 'kilo')
    && typeof value.providerName === 'string'
    && typeof value.adapterMode === 'string'
    && typeof value.description === 'string'
    && (value.defaultReviewMode === 'advisory' || value.defaultReviewMode === 'blocking')
    && typeof value.defaultGate === 'string'
    && isStringArray(value.focusAreas)
    && isStringArray(value.checklistIds)
    && isStringArray(value.memoryTags)
    && isStringArray(value.instructionTags)
    && Array.isArray(value.remediationTargets) && value.remediationTargets.every(isRemediationTarget)
    && isReviewProviderStatus(value.auth)
    && Array.isArray(value.recentRuns) && value.recentRuns.every(isReviewRunSummary)
    && (value.latestRun === undefined || isReviewRunSummary(value.latestRun))
    && Array.isArray(value.checklists) && value.checklists.every(isReviewerChecklist)
}

function hasAgentsResponse(value: unknown): value is AgentsResponse {
  return isRecord(value) && Array.isArray(value.agents) && value.agents.every(isReviewerAgent)
}

function hasRunsResponse(value: unknown): value is RunsResponse {
  return isRecord(value) && Array.isArray(value.runs) && value.runs.every(isReviewRunSummary)
}

function hasRunResponse(value: unknown): value is RunResponse {
  return isRecord(value) && isReviewRunSummary(value.run)
}

function hasChecklistResponse(value: unknown): value is ChecklistResponse {
  return isRecord(value) && isReviewerChecklist(value.checklist)
}

type Translate = (key: string, options?: Record<string, unknown>) => string

function invalidResponseError(resource: string, t: Translate) {
  return new Error(t('reviewerAgents.loadError.invalidResponse', { resource }))
}

function reviewerAgentsErrorMessage(err: unknown, t: Translate): string {
  if (err instanceof ApiRequestError && err.status === 404) {
    return t('reviewerAgents.loadError.notFound')
  }
  return getErrorMessage(err)
}

const severityTone: Record<ReviewSeverity, string> = {
  critical: 'bg-destructive text-white',
  major: 'bg-amber-500 text-white',
  minor: 'bg-primary/10 text-primary',
  info: 'bg-muted text-muted-foreground',
}

function counts(findings: ReviewFinding[]) {
  return findings.reduce<Record<ReviewSeverity, number>>((acc, finding) => {
    acc[finding.severity] += 1
    return acc
  }, { critical: 0, major: 0, minor: 0, info: 0 })
}

function gateLabel(run?: ReviewRunSummary, auth?: ReviewProviderStatus): { label: string; className: string; icon: typeof ShieldCheck } {
  if (auth && (!auth.installed || auth.authenticated === false)) return { label: 'Auth missing', className: 'bg-destructive text-white', icon: ShieldAlert }
  if (!run) return { label: 'No runs yet', className: 'bg-muted text-muted-foreground', icon: Clock3 }
  if (run.status === 'failed') return { label: 'Review failed', className: 'bg-destructive text-white', icon: XCircle }
  if (run.blocked) return { label: 'Blocking findings', className: 'bg-destructive text-white', icon: ShieldAlert }
  if (run.findings.length > 0) return { label: 'Advisory findings', className: 'bg-amber-500 text-white', icon: AlertTriangle }
  if (run.status === 'skipped') return { label: 'Skipped', className: 'bg-muted text-muted-foreground', icon: Clock3 }
  return { label: 'Clean', className: 'bg-emerald-600 text-white', icon: ShieldCheck }
}

function formatDate(value?: string) {
  if (!value) return '—'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function duration(result: ReviewResult) {
  if (!result.completedAt) return 'running'
  const ms = new Date(result.completedAt).getTime() - new Date(result.startedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${Math.round(ms / 1000)}s`
}

function TagList({ tags }: { tags: string[] }) {
  return <div className="flex flex-wrap gap-1">{tags.map((tag) => <Badge key={tag} variant="outline" className="text-[10px]">{tag}</Badge>)}</div>
}

function ChecklistEditor({ checklist, onSaved }: { checklist: ReviewerChecklist; onSaved: (checklist: ReviewerChecklist) => void }) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(checklist.title)
  const [description, setDescription] = useState(checklist.description)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setTitle(checklist.title)
    setDescription(checklist.description)
  }, [checklist])

  const save = async () => {
    setSaving(true)
    try {
      const response = await api.patch<ChecklistResponse>(`/reviewer-agents/checklists/${checklist.id}`, { title, description })
      if (!hasChecklistResponse(response)) throw invalidResponseError('checklist', t)
      onSaved(response.checklist)
      setEditing(false)
      toast.success('Checklist updated')
    } catch (err) {
      toastError(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {editing ? <Input value={title} onChange={(e) => setTitle(e.target.value)} className="mb-2" /> : <CardTitle className="text-sm">{checklist.title}</CardTitle>}
            {editing ? <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} /> : <CardDescription>{checklist.description}</CardDescription>}
          </div>
          {editing ? (
            <div className="flex gap-1">
              <Button size="sm" variant="outline" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
              <Button size="sm" onClick={save} disabled={saving}>{saving && <Loader2 className="size-3 animate-spin" />}Save</Button>
            </div>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}><SquarePen className="size-3.5" /> Edit</Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="space-y-2">
          {checklist.items.map((item) => (
            <div key={item.id} className="rounded-md border border-border p-2">
              <div className="flex items-center gap-2">
                <Badge variant={item.required ? 'default' : 'outline'} className="text-[10px]">{item.required ? 'required' : 'optional'}</Badge>
                <span className="font-medium">{item.label}</span>
              </div>
              {item.description && <p className="mt-1 text-xs text-muted-foreground">{item.description}</p>}
            </div>
          ))}
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Memory tags</p>
          <TagList tags={checklist.memoryTags} />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Instruction tags</p>
          <TagList tags={checklist.instructionTags} />
        </div>
      </CardContent>
    </Card>
  )
}

function ReviewerAgentCard({ agent, selected, onSelect, onRun }: { agent: ReviewerAgent; selected: boolean; onSelect: () => void; onRun: () => void }) {
  const gate = gateLabel(agent.latestRun, agent.auth)
  const GateIcon = gate.icon
  const latestCounts = counts(agent.latestRun?.findings ?? [])
  const ready = agent.auth.installed && agent.auth.authenticated !== false

  return (
    <Card className={cn('cursor-pointer transition-colors hover:border-primary/50', selected && 'border-primary bg-primary/5')} onClick={onSelect}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base"><Bot className="size-4 text-primary" />{agent.name}</CardTitle>
            <CardDescription>{agent.description}</CardDescription>
          </div>
          <Badge className={gate.className}><GateIcon className="mr-1 size-3" />{gate.label}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div><span className="text-muted-foreground">Provider</span><p className="font-medium">{agent.providerName}</p></div>
          <div><span className="text-muted-foreground">Adapter</span><p className="font-medium">{agent.auth.localReviewMode ?? agent.adapterMode}</p></div>
          <div><span className="text-muted-foreground">Version</span><p className="truncate font-medium">{agent.auth.version ?? 'Not installed'}</p></div>
          <div><span className="text-muted-foreground">Default gate</span><p className="font-medium">{agent.defaultGate}</p></div>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['critical', 'major', 'minor', 'info'] as ReviewSeverity[]).map((severity) => (
            <Badge key={severity} className={cn('text-[10px]', severityTone[severity])}>{severity}: {latestCounts[severity]}</Badge>
          ))}
        </div>
        <div className="space-y-1"><p className="text-xs font-medium text-muted-foreground">Memory</p><TagList tags={agent.memoryTags} /></div>
        {!ready && <p className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">{agent.auth.error ?? 'Install or authenticate this reviewer CLI before running reviews.'}</p>}
        <Button className="w-full" disabled={!ready} onClick={(event) => { event.stopPropagation(); onRun() }}>
          <Play className="size-4" /> Run {agent.providerName} review
        </Button>
      </CardContent>
    </Card>
  )
}

function RunDetail({ run, onStateChange }: { run?: ReviewRunSummary; onStateChange: (run: ReviewRunSummary) => void }) {
  const { t } = useTranslation()
  const [expandedRaw, setExpandedRaw] = useState<string | null>(null)
  const [updating, setUpdating] = useState<string | null>(null)
  if (!run) return <Card><CardContent className="p-6 text-sm text-muted-foreground">Select a reviewer or run a review to see result details.</CardContent></Card>
  const runCounts = counts(run.findings)

  const changeState = async (finding: ReviewFinding, state: FindingState) => {
    setUpdating(finding.id)
    try {
      const response = await api.patch<RunResponse>(`/reviewer-agents/runs/${run.id}/findings/${finding.id}`, { state })
      if (!hasRunResponse(response)) throw invalidResponseError('run', t)
      onStateChange(response.run)
    } catch (err) {
      toastError(err)
    } finally {
      setUpdating(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Review run detail</CardTitle>
            <CardDescription>{run.id}</CardDescription>
          </div>
          <Badge className={gateLabel(run).className}>{gateLabel(run).label}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><span className="text-muted-foreground">Status</span><p className="font-medium">{run.status}</p></div>
          <div><span className="text-muted-foreground">Mode</span><p className="font-medium">{run.mode}</p></div>
          <div><span className="text-muted-foreground">Artifact</span><p className="truncate font-mono text-xs">{run.artifactPath}</p></div>
          <div><span className="text-muted-foreground">Findings</span><p className="font-medium">C {runCounts.critical} · M {runCounts.major} · m {runCounts.minor} · i {runCounts.info}</p></div>
        </div>
        {run.results.map((result) => (
          <div key={result.id} className="rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">{result.provider} · {result.localReviewMode ?? 'adapter'}</p>
                <p className="text-xs text-muted-foreground">{result.repoPath} · {result.base ?? result.baseCommit ?? 'default base'} → {result.head ?? 'working tree'} · {formatDate(result.startedAt)} · {duration(result)}</p>
              </div>
              <Badge variant={result.status === 'succeeded' ? 'default' : 'outline'}>{result.status}</Badge>
            </div>
            {result.error && <p className="mt-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">{result.error}</p>}
            {result.rawOutput && (
              <div className="mt-2">
                <Button size="sm" variant="ghost" onClick={() => setExpandedRaw(expandedRaw === result.id ? null : result.id)}>
                  {expandedRaw === result.id ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />} Raw output disclosure
                </Button>
                {expandedRaw === result.id && <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">{result.rawOutput}</pre>}
              </div>
            )}
          </div>
        ))}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Findings</h3>
          {run.findings.length === 0 ? <p className="text-sm text-muted-foreground">No findings reported.</p> : run.findings.map((finding) => (
            <div key={finding.id} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className={severityTone[finding.severity]}>{finding.severity}</Badge>
                    <Badge variant="outline">{finding.state ?? 'open'}</Badge>
                    <span className="font-medium">{finding.title}</span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{finding.message}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{finding.file ?? 'no file'}{finding.line ? `:${finding.line}` : ''} · {finding.provider} · confidence {finding.confidence}</p>
                </div>
                <Select value={finding.state ?? 'open'} onValueChange={(value) => changeState(finding, value as FindingState)} disabled={updating === finding.id}>
                  <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">open</SelectItem>
                    <SelectItem value="fixed">fixed</SelectItem>
                    <SelectItem value="ignored">ignored</SelectItem>
                    <SelectItem value="needs-decision">needs decision</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

export function ReviewerAgentsPage() {
  const { user } = useAuth()
  if (user?.role !== 'admin') return <Navigate to="/" replace />
  return <ReviewerAgentsAdminPage />
}

function ReviewerAgentsAdminPage() {
  const { t } = useTranslation()
  const [agents, setAgents] = useState<ReviewerAgent[]>([])
  const [runs, setRuns] = useState<ReviewRunSummary[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<ReviewerAgentId>('coderabbit-reviewer')
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [repoPath, setRepoPath] = useState('')
  const [base, setBase] = useState('origin/main')
  const [mode, setMode] = useState<ReviewMode>('advisory')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [running, setRunning] = useState<ReviewerAgentId | null>(null)

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId)
  const selectedRun = useMemo(() => runs.find((run) => run.id === selectedRunId) ?? selectedAgent?.latestRun ?? runs[0], [runs, selectedRunId, selectedAgent])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setLoadError(null)
      const [agentResponse, runResponse] = await Promise.all([
        api.get<AgentsResponse>(`/reviewer-agents${repoPath ? `?repoPath=${encodeURIComponent(repoPath)}` : ''}`),
        api.get<RunsResponse>('/reviewer-agents/runs?limit=20'),
      ])
      if (!hasAgentsResponse(agentResponse)) throw invalidResponseError('agents', t)
      if (!hasRunsResponse(runResponse)) throw invalidResponseError('runs', t)
      setAgents(agentResponse.agents)
      setRuns(runResponse.runs)
      setSelectedRunId((current) => current ?? runResponse.runs[0]?.id ?? null)
    } catch (err) {
      const message = reviewerAgentsErrorMessage(err, t)
      setLoadError(message)
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [repoPath, t])

  useEffect(() => { void load() }, [load])

  const runReview = async (agent: ReviewerAgent) => {
    setRunning(agent.id)
    try {
      const response = await api.post<RunResponse>(`/reviewer-agents/${agent.id}/runs`, { repoPath: repoPath || '.', base: base || undefined, mode, light: true })
      if (!hasRunResponse(response)) throw invalidResponseError('run', t)
      setSelectedRunId(response.run.id)
      setRuns((prev) => [response.run, ...prev.filter((run) => run.id !== response.run.id)])
      toast.success(`${agent.name} completed: ${response.run.blocked ? 'blocked' : response.run.status}`)
      const agentResponse = await api.get<AgentsResponse>(`/reviewer-agents${repoPath ? `?repoPath=${encodeURIComponent(repoPath)}` : ''}`)
      if (!hasAgentsResponse(agentResponse)) throw invalidResponseError('agents', t)
      setAgents(agentResponse.agents)
    } catch (err) {
      toastError(err)
    } finally {
      setRunning(null)
    }
  }

  const handleChecklistSaved = (checklist: ReviewerChecklist) => {
    setAgents((prev) => prev.map((agent) => ({
      ...agent,
      checklists: agent.checklists.map((item) => item.id === checklist.id ? checklist : item),
    })))
  }

  const handleRunUpdated = (run: ReviewRunSummary) => {
    setRuns((prev) => prev.map((item) => item.id === run.id ? run : item))
  }

  return (
    <div className="surface-base flex h-full flex-col overflow-hidden">
      <PageHeader
        icon={GitPullRequest}
        title="Reviewer Agents"
        actions={
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:justify-end">
            <Input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="Repository path (blank = server cwd)" className="h-9 w-full sm:w-72" aria-label="Repository path" />
            <Input value={base} onChange={(e) => setBase(e.target.value)} className="h-9 w-full sm:w-40" aria-label="Base ref" />
            <Select value={mode} onValueChange={(value) => setMode(value as ReviewMode)}>
              <SelectTrigger className="h-9 w-full sm:w-32"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="advisory">advisory</SelectItem><SelectItem value="blocking">blocking</SelectItem></SelectContent>
            </Select>
            <Button className="w-full sm:w-auto" variant="outline" onClick={load} disabled={loading}><RefreshCw className={cn('size-4', loading && 'animate-spin')} /> Refresh</Button>
          </div>
        }
      >
        <p className="text-xs text-muted-foreground">First-class CodeRabbit and Kilo Code reviewer agents for pre-commit/pre-PR local review gates.</p>
      </PageHeader>
      {loading && agents.length === 0 ? (
        <div className="flex flex-1 items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : loadError && agents.length === 0 ? (
        <main className="min-h-0 flex-1 overflow-y-auto p-4">
          <Card className="border-destructive/40 bg-destructive/5">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base text-destructive"><ShieldAlert className="size-4" />{t('reviewerAgents.loadError.title')}</CardTitle>
              <CardDescription>{loadError}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>{t('reviewerAgents.loadError.description')}</p>
              <Button variant="outline" onClick={load} disabled={loading}><RefreshCw className={cn('size-4', loading && 'animate-spin')} /> {t('reviewerAgents.loadError.retry')}</Button>
            </CardContent>
          </Card>
        </main>
      ) : (
        <main className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(420px,0.9fr)]">
            <section className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                {agents.map((agent) => (
                  <div key={agent.id} className="relative">
                    {running === agent.id && <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-background/60"><Loader2 className="size-5 animate-spin" /></div>}
                    <ReviewerAgentCard agent={agent} selected={agent.id === selectedAgentId} onSelect={() => setSelectedAgentId(agent.id)} onRun={() => runReview(agent)} />
                  </div>
                ))}
              </div>
              {selectedAgent && (
                <div className="grid gap-3 lg:grid-cols-2">
                  {selectedAgent.checklists.map((checklist) => <ChecklistEditor key={checklist.id} checklist={checklist} onSaved={handleChecklistSaved} />)}
                  <Card>
                    <CardHeader><CardTitle className="text-sm">Remediation handoff</CardTitle><CardDescription>Task assignment seam for follow-up fixes.</CardDescription></CardHeader>
                    <CardContent className="space-y-2 text-sm">
                      {selectedAgent.remediationTargets.map((target) => (
                        <div key={target.agentSlug} className="flex items-center justify-between rounded-md border border-border p-2">
                          <div><p className="font-medium">{target.label}</p><p className="text-xs text-muted-foreground">{target.reason}</p></div>
                          <Button size="sm" variant="outline" onClick={() => toast.info('Spawn-fix flow is stubbed for follow-up; finding state tracking is active.')}><ExternalLink className="size-3" /> Stub</Button>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                </div>
              )}
            </section>
            <aside className="space-y-4">
              <RunDetail run={selectedRun} onStateChange={handleRunUpdated} />
              <Card>
                <CardHeader><CardTitle className="text-sm">Recent review runs</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {runs.length === 0 ? <p className="text-sm text-muted-foreground">No local review artifacts yet.</p> : runs.map((run) => (
                    <button key={run.id} type="button" onClick={() => setSelectedRunId(run.id)} className={cn('w-full rounded-md border p-2 text-left text-sm hover:border-primary', selectedRun?.id === run.id && 'border-primary bg-primary/5')}>
                      <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{run.id}</span>{run.status === 'failed' ? <XCircle className="size-4 text-destructive" /> : run.blocked ? <ShieldAlert className="size-4 text-destructive" /> : <CheckCircle2 className="size-4 text-emerald-600" />}</div>
                      <p className="text-xs text-muted-foreground">{run.status} · {run.mode} · {run.findings.length} finding(s)</p>
                    </button>
                  ))}
                </CardContent>
              </Card>
            </aside>
          </div>
        </main>
      )}
    </div>
  )
}
