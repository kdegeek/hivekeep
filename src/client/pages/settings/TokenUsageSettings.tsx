import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Button } from '@/client/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/client/components/ui/select'
import { Card, CardContent } from '@/client/components/ui/card'
import { Skeleton } from '@/client/components/ui/skeleton'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/components/ui/avatar'
import { ProviderIcon } from '@/client/components/common/ProviderIcon'
import { ArrowDownRight, ArrowUpRight, Activity, Hash, Zap, X, ChevronLeft, ChevronRight } from 'lucide-react'
import { api } from '@/client/lib/api'
import { computeBillableInput, computeCacheHitRate } from '@/shared/billing'
import type { LlmUsageRow, UsageSummaryRow } from '@/shared/types'

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

function hitRateColor(ratio: number): string {
  if (ratio >= 0.7) return 'text-success'
  if (ratio >= 0.3) return 'text-warning'
  return 'text-muted-foreground/70'
}

type Period = '24h' | '7d' | '30d' | 'all'
type GroupBy = 'provider_type' | 'model_id' | 'kin_id' | 'call_site' | 'day'

interface KinInfo {
  id: string
  name: string
  role: string
  avatarUrl: string | null
}

const PERIODS: Period[] = ['24h', '7d', '30d', 'all']
const GROUP_OPTIONS: GroupBy[] = ['model_id', 'provider_type', 'kin_id', 'call_site', 'day']

function periodToFrom(period: Period): number | undefined {
  if (period === 'all') return undefined
  const ms = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 }
  return Date.now() - ms[period]
}

function formatTokens(n: number): string {
  if (n === 0) return '0'
  if (n < 1_000) return n.toLocaleString()
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function formatNumber(n: number): string {
  return n.toLocaleString()
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&')
  return qs ? `?${qs}` : ''
}

// ─── Summary Cards ──────────────────────────────────────────────────────────

function SummaryCards({ data, loading, t }: {
  data: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens: number; cacheWriteTokens: number; billableInputTokens: number; calls: number }
  loading: boolean
  t: TFunction
}) {
  // Use the provider-aware billable input computed server-side. Aggregations
  // span multiple providers (e.g. one Kin used both Anthropic and OpenAI),
  // so applying a single client-side multiplier here would be wrong.
  const billableInput = data.billableInputTokens
  const billableTotal = billableInput + data.outputTokens
  const hitRate = computeCacheHitRate(data)
  const cards = [
    {
      label: t('settings.tokenUsage.billableTotal'),
      value: `≈ ${formatTokens(billableTotal)}`,
      icon: Zap,
      color: 'text-primary',
      sub: hitRate > 0 ? `${formatPercent(hitRate)} ${t('settings.tokenUsage.cacheHit')}` : undefined,
      subClass: hitRateColor(hitRate),
    },
    { label: t('settings.tokenUsage.inputBillable'), value: `≈ ${formatTokens(billableInput)}`, icon: ArrowDownRight, color: 'text-foreground' },
    { label: t('settings.tokenUsage.outputTokens'), value: formatTokens(data.outputTokens), icon: ArrowUpRight, color: 'text-chart-2' },
    { label: t('settings.tokenUsage.apiCalls'), value: formatNumber(data.calls), icon: Hash, color: 'text-muted-foreground' },
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((card) => (
        <Card key={card.label} className="py-3 px-4 gap-1">
          <CardContent className="p-0">
            {loading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <card.icon className={`size-3.5 ${card.color}`} />
                  {card.label}
                </div>
                <div className="text-xl font-semibold tabular-nums">{card.value}</div>
                {card.sub && (
                  <div className={`text-[10px] tabular-nums ${card.subClass ?? 'text-muted-foreground'}`}>{card.sub}</div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

// ─── Daily Sparkline ────────────────────────────────────────────────────────

function DailySparkline({ data, t }: { data: UsageSummaryRow[]; t: (key: string) => string }) {
  if (data.length === 0) return null

  const width = 320
  const height = 40
  const barWidth = Math.max(2, width / data.length - 1)
  const gap = 1
  // Use the billable-input equivalent (provider-aware, accounts for cache
  // discounts) to match the SummaryCards above. Gross inputTokens dramatically
  // overstates cost on Anthropic with prompt caching: a day with 500k cache
  // reads counts as 500k of "input" gross but ~50k billable. The chart was
  // making heavy-cache days look 5-10x bigger than they actually cost.
  const maxTotal = Math.max(1, ...data.map((d) => d.billableInputTokens + d.outputTokens))

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Activity className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">{t('settings.tokenUsage.dailyTrend')}</span>
      </div>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="w-full">
        {data.map((d, i) => {
          const total = d.billableInputTokens + d.outputTokens
          const totalH = (total / maxTotal) * height
          const inputH = (d.billableInputTokens / maxTotal) * height
          const outputH = (d.outputTokens / maxTotal) * height
          const x = i * (barWidth + gap)
          return (
            <g key={d.group}>
              {outputH > 0 && (
                <rect x={x} y={height - totalH} width={barWidth} height={outputH} rx={1} className="fill-chart-2/60" />
              )}
              {inputH > 0 && (
                <rect x={x} y={height - totalH + outputH} width={barWidth} height={inputH} rx={1} className="fill-primary/60" />
              )}
            </g>
          )
        })}
      </svg>
      <div className="flex items-center gap-3 text-[10px] text-muted-foreground/60">
        <span className="flex items-center gap-1">
          <span className="inline-block size-1.5 rounded-full bg-primary/60" />
          {t('settings.tokenUsage.legendInput')}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block size-1.5 rounded-full bg-chart-2/60" />
          {t('settings.tokenUsage.legendOutput')}
        </span>
      </div>
    </div>
  )
}

// ─── Row Label (with avatar/icon) ──────────────────────────────────────────

function RowLabel({ group, groupBy, kinMap }: {
  group: string
  groupBy: GroupBy
  kinMap: Map<string, KinInfo>
}) {
  if (groupBy === 'kin_id') {
    if (!group) return <span className="truncate font-medium text-muted-foreground">(unknown)</span>
    const kin = kinMap.get(group)
    if (kin) {
      const name = kin.name || group.slice(0, 8)
      const initials = name.slice(0, 2).toUpperCase()
      return (
        <div className="flex items-center gap-2 min-w-0">
          <Avatar className="size-5 shrink-0">
            {kin.avatarUrl && <AvatarImage src={kin.avatarUrl} alt={name} />}
            <AvatarFallback className="text-[8px] bg-secondary">{initials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <span className="block truncate text-xs font-medium">{name}</span>
            {kin.role && (
              <span className="block truncate text-[10px] text-muted-foreground leading-tight">{kin.role}</span>
            )}
          </div>
        </div>
      )
    }
    // Fallback for unknown kin — show truncated UUID
    return <span className="truncate font-medium text-muted-foreground" title={group}>{group.slice(0, 8)}…</span>
  }

  if (groupBy === 'provider_type') {
    return (
      <div className="flex items-center gap-2 min-w-0">
        <ProviderIcon providerType={group} className="size-4 shrink-0" variant="color" />
        <span className="truncate font-medium capitalize">{group}</span>
      </div>
    )
  }

  return <span className="truncate font-medium" title={group}>{group || '(unknown)'}</span>
}

// ─── Breakdown Table ────────────────────────────────────────────────────────

function BreakdownTable({ rows, loading, groupBy, kinMap, t }: {
  rows: UsageSummaryRow[]
  loading: boolean
  groupBy: GroupBy
  kinMap: Map<string, KinInfo>
  t: TFunction
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        {t('settings.tokenUsage.noData')}
      </div>
    )
  }

  return (
    <div className="glass-strong rounded-lg overflow-hidden">
      {/* Header — wider grid: group | billable in | output | hit% | calls */}
      <div className="grid grid-cols-[1fr_90px_80px_60px_60px] gap-2 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground/60 border-b border-border/30">
        <span>{t('settings.tokenUsage.columnGroup')}</span>
        <span className="text-right">{t('settings.tokenUsage.columnInputBillable')}</span>
        <span className="text-right">{t('settings.tokenUsage.columnOutput')}</span>
        <span className="text-right" title={t('settings.tokenUsage.columnCacheHitFull')}>%</span>
        <span className="text-right">{t('settings.tokenUsage.columnCalls')}</span>
      </div>
      {/* Rows */}
      <div className="max-h-[300px] overflow-y-auto">
        {rows.map((row) => {
          // Provider-aware billable input is computed server-side (CASE WHEN
          // per provider_type, summed across rows in the group).
          const billable = row.billableInputTokens
          const hit = computeCacheHitRate(row)
          const hasCache = (row.cacheReadTokens > 0) || (row.cacheWriteTokens > 0)
          return (
            <div
              key={row.group}
              className="grid grid-cols-[1fr_90px_80px_60px_60px] gap-2 px-3 py-1.5 text-xs hover:bg-muted/30 border-b border-border/20 items-center"
              title={hasCache
                ? `Gross input ${formatTokens(row.inputTokens)} = fresh ${formatTokens(Math.max(0, row.inputTokens - row.cacheReadTokens - row.cacheWriteTokens))} + cache write ${formatTokens(row.cacheWriteTokens)} (×1.25) + cache read ${formatTokens(row.cacheReadTokens)} (×0.1)`
                : undefined}
            >
              <RowLabel group={row.group} groupBy={groupBy} kinMap={kinMap} />
              <span className="text-right font-mono tabular-nums font-semibold text-primary">
                ≈ {formatTokens(billable)}
              </span>
              <span className="text-right font-mono tabular-nums text-muted-foreground">
                {formatTokens(row.outputTokens)}
              </span>
              <span className={`text-right font-mono tabular-nums ${hasCache ? hitRateColor(hit) : 'text-muted-foreground/40'}`}>
                {hasCache ? formatPercent(hit) : '—'}
              </span>
              <span className="text-right font-mono tabular-nums text-muted-foreground">
                {formatNumber(row.count)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Kin Filter ─────────────────────────────────────────────────────────────

function KinFilter({ value, onValueChange, kins, t }: {
  value: string
  onValueChange: (v: string) => void
  kins: KinInfo[]
  t: TFunction
}) {
  const selectedKin = kins.find((k) => k.id === value)

  return (
    <div className="relative">
      <Select value={value || '__all__'} onValueChange={(v) => onValueChange(v === '__all__' ? '' : v)}>
        <SelectTrigger className={`w-[200px] h-8 text-xs ${value ? 'pr-7' : ''}`}>
          {selectedKin ? (
            <div className="flex items-center gap-2 min-w-0">
              <Avatar className="size-4 shrink-0">
                {selectedKin.avatarUrl && <AvatarImage src={selectedKin.avatarUrl} alt={selectedKin.name} />}
                <AvatarFallback className="text-[7px] bg-secondary">{(selectedKin.name || '??').slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
              <span className="truncate">{selectedKin.name}</span>
            </div>
          ) : (
            <span className="text-muted-foreground">{t('settings.tokenUsage.filterKin')}</span>
          )}
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="__all__" className="text-xs">{t('settings.tokenUsage.filterKin')}</SelectItem>
          {kins.map((kin) => (
            <SelectItem key={kin.id} value={kin.id} className="text-xs py-1.5">
              <div className="flex items-center gap-2 min-w-0">
                <Avatar className="size-5 shrink-0">
                  {kin.avatarUrl && <AvatarImage src={kin.avatarUrl} alt={kin.name} />}
                  <AvatarFallback className="text-[8px] bg-secondary">{kin.name.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <span className="block truncate text-xs">{kin.name}</span>
                  {kin.role && (
                    <span className="block truncate text-[10px] text-muted-foreground leading-tight">{kin.role}</span>
                  )}
                </div>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onValueChange('') }}
          className="absolute right-7 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground/60 hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  )
}

// ─── Provider Filter ────────────────────────────────────────────────────────

function ProviderFilter({ value, onValueChange, providers, t }: {
  value: string
  onValueChange: (v: string) => void
  providers: string[]
  t: TFunction
}) {
  return (
    <div className="relative">
      <Select value={value || '__all__'} onValueChange={(v) => onValueChange(v === '__all__' ? '' : v)}>
        <SelectTrigger className={`w-[200px] h-8 text-xs ${value ? 'pr-7' : ''}`}>
          {value ? (
            <div className="flex items-center gap-2 min-w-0">
              <ProviderIcon providerType={value} className="size-3.5 shrink-0" variant="color" />
              <span className="truncate capitalize">{value}</span>
            </div>
          ) : (
            <span className="text-muted-foreground">{t('settings.tokenUsage.filterProvider')}</span>
          )}
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="__all__" className="text-xs">{t('settings.tokenUsage.filterProvider')}</SelectItem>
          {providers.map((p) => (
            <SelectItem key={p} value={p} className="text-xs">
              <span className="flex items-center gap-2">
                <ProviderIcon providerType={p} className="size-4" variant="color" />
                <span className="capitalize">{p}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onValueChange('') }}
          className="absolute right-7 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground/60 hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  )
}

// ─── Detail Table (individual requests) ────────────────────────────────────

const PAGE_SIZE = 25

function DetailTable({ rows, loading, page, totalCount, onPageChange, kinMap, t }: {
  rows: LlmUsageRow[]
  loading: boolean
  page: number
  totalCount: number
  onPageChange: (page: number) => void
  kinMap: Map<string, KinInfo>
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))

  if (loading && rows.length === 0) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        {t('settings.tokenUsage.noData')}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="glass-strong rounded-lg overflow-hidden">
        {/* Header */}
        <div className="grid grid-cols-[140px_1fr_1fr_80px_80px_70px_50px_50px] gap-2 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground/60 border-b border-border/30">
          <span>{t('settings.tokenUsage.detailDate')}</span>
          <span>{t('settings.tokenUsage.detailKin')}</span>
          <span>{t('settings.tokenUsage.detailModel')}</span>
          <span>{t('settings.tokenUsage.detailCallSite')}</span>
          <span className="text-right">{t('settings.tokenUsage.columnInputBillable')}</span>
          <span className="text-right">{t('settings.tokenUsage.columnOutput')}</span>
          <span className="text-right" title={t('settings.tokenUsage.columnCacheHitFull')}>%</span>
          <span className="text-right">{t('settings.tokenUsage.detailSteps')}</span>
        </div>
        {/* Rows */}
        <div className="max-h-[400px] overflow-y-auto">
          {rows.map((row) => {
            const kin = row.kinId ? kinMap.get(row.kinId) : null
            const date = new Date(row.createdAt)
            const usage = {
              inputTokens: row.inputTokens ?? 0,
              cacheReadTokens: row.cacheReadTokens ?? 0,
              cacheWriteTokens: row.cacheWriteTokens ?? 0,
            }
            // Provider-aware: each call belongs to a single provider, so we
            // use its multipliers directly here.
            const billable = computeBillableInput(usage, row.providerType)
            const hit = computeCacheHitRate(usage)
            const hasCache = (row.cacheReadTokens ?? 0) > 0 || (row.cacheWriteTokens ?? 0) > 0
            const fresh = Math.max(0, (row.inputTokens ?? 0) - (row.cacheReadTokens ?? 0) - (row.cacheWriteTokens ?? 0))
            return (
              <div
                key={row.id}
                className="grid grid-cols-[140px_1fr_1fr_80px_80px_70px_50px_50px] gap-2 px-3 py-1.5 text-xs hover:bg-muted/30 border-b border-border/20 items-center"
                title={hasCache
                  ? `Gross input ${formatTokens(row.inputTokens ?? 0)} = fresh ${formatTokens(fresh)} + cache write ${formatTokens(row.cacheWriteTokens ?? 0)} (×1.25) + cache read ${formatTokens(row.cacheReadTokens ?? 0)} (×0.1)`
                  : `Input ${formatTokens(row.inputTokens ?? 0)} (no cache)`}
              >
                <span className="text-muted-foreground tabular-nums" title={date.toISOString()}>
                  {date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}{' '}
                  {date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <div className="min-w-0">
                  {kin ? (
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Avatar className="size-4 shrink-0">
                        {kin.avatarUrl && <AvatarImage src={kin.avatarUrl} alt={kin.name} />}
                        <AvatarFallback className="text-[7px] bg-secondary">{kin.name.slice(0, 2).toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <span className="truncate">{kin.name}</span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 min-w-0">
                  {row.providerType && <ProviderIcon providerType={row.providerType} className="size-3.5 shrink-0" variant="color" />}
                  <span className="truncate" title={row.modelId ?? undefined}>{row.modelId ?? '—'}</span>
                </div>
                <span className="truncate text-muted-foreground">{row.callSite}</span>
                <span className="text-right font-mono tabular-nums font-semibold text-primary">
                  ≈ {formatTokens(billable)}
                </span>
                <span className="text-right font-mono tabular-nums text-muted-foreground">
                  {formatTokens(row.outputTokens ?? 0)}
                </span>
                <span className={`text-right font-mono tabular-nums ${hasCache ? hitRateColor(hit) : 'text-muted-foreground/40'}`}>
                  {hasCache ? formatPercent(hit) : '—'}
                </span>
                <span className="text-right font-mono tabular-nums text-muted-foreground">
                  {row.stepCount}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{t('settings.tokenUsage.detailShowing', { from: page * PAGE_SIZE + 1, to: Math.min((page + 1) * PAGE_SIZE, totalCount), total: totalCount })}</span>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            disabled={page === 0}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="px-2 tabular-nums">{page + 1} / {totalPages}</span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            disabled={page >= totalPages - 1}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function TokenUsageSettings({ initialKinFilter }: { initialKinFilter?: string } = {}) {
  const { t } = useTranslation()

  const [period, setPeriod] = useState<Period>('7d')
  const [groupBy, setGroupBy] = useState<GroupBy>(initialKinFilter ? 'model_id' : 'model_id')
  const [kinFilter, setKinFilter] = useState<string>(initialKinFilter ?? '')
  const [providerFilter, setProviderFilter] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [summaryRows, setSummaryRows] = useState<UsageSummaryRow[]>([])
  const [dailyData, setDailyData] = useState<UsageSummaryRow[]>([])

  // Detail rows (individual requests)
  const [detailRows, setDetailRows] = useState<LlmUsageRow[]>([])
  const [detailCount, setDetailCount] = useState(0)
  const [detailPage, setDetailPage] = useState(0)
  const [detailLoading, setDetailLoading] = useState(false)

  // Kin info for resolving UUIDs to names/avatars
  const [kins, setKins] = useState<KinInfo[]>([])
  const kinMap = useMemo(() => new Map(kins.map((k) => [k.id, k])), [kins])

  // Available filter options (populated from data)
  const [kinOptionIds, setKinOptionIds] = useState<string[]>([])
  const [providerOptions, setProviderOptions] = useState<string[]>([])

  // Fetch kins + filter options on mount
  useEffect(() => {
    Promise.all([
      api.get<{ kins: KinInfo[] }>('/kins'),
      api.get<{ summary: UsageSummaryRow[] }>('/usage/summary?groupBy=kin_id'),
      api.get<{ summary: UsageSummaryRow[] }>('/usage/summary?groupBy=provider_type'),
    ]).then(([kinsRes, kinUsageRes, providersRes]) => {
      setKins(kinsRes.kins)
      setKinOptionIds(kinUsageRes.summary.filter((r) => r.group).map((r) => r.group))
      setProviderOptions(providersRes.summary.filter((r) => r.group).map((r) => r.group))
    }).catch(() => {})
  }, [])

  // Kins that have usage data (for filter dropdown)
  const kinFilterOptions = useMemo(
    () => kins.filter((k) => kinOptionIds.includes(k.id)),
    [kins, kinOptionIds],
  )

  // Fetch data when filters change
  useEffect(() => {
    setLoading(true)
    const from = periodToFrom(period)
    const base = {
      from,
      kinId: kinFilter || undefined,
      providerType: providerFilter || undefined,
    }

    const mainQuery = buildQuery({ groupBy, ...base })
    const dailyQuery = groupBy === 'day' ? null : buildQuery({ groupBy: 'day', ...base })

    const promises: Promise<{ summary: UsageSummaryRow[] }>[] = [
      api.get<{ summary: UsageSummaryRow[] }>(`/usage/summary${mainQuery}`),
    ]
    if (dailyQuery) {
      promises.push(api.get<{ summary: UsageSummaryRow[] }>(`/usage/summary${dailyQuery}`))
    }

    Promise.all(promises)
      .then(([mainRes, dailyRes]) => {
        if (!mainRes) return
        setSummaryRows(mainRes.summary)
        setDailyData(dailyRes ? dailyRes.summary : mainRes.summary)
      })
      .catch(() => {
        setSummaryRows([])
        setDailyData([])
      })
      .finally(() => setLoading(false))
  }, [period, groupBy, kinFilter, providerFilter])

  // Reset detail page when filters change
  useEffect(() => {
    setDetailPage(0)
  }, [period, kinFilter, providerFilter])

  // Fetch detail rows (individual requests)
  const fetchDetail = useCallback((page: number) => {
    setDetailLoading(true)
    const from = periodToFrom(period)
    const query = buildQuery({
      from,
      kinId: kinFilter || undefined,
      providerType: providerFilter || undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    })
    api.get<{ rows: LlmUsageRow[]; count: number }>(`/usage${query}`)
      .then((res) => {
        setDetailRows(res.rows)
        setDetailCount(res.count)
      })
      .catch(() => {
        setDetailRows([])
        setDetailCount(0)
      })
      .finally(() => setDetailLoading(false))
  }, [period, kinFilter, providerFilter])

  useEffect(() => {
    fetchDetail(detailPage)
  }, [detailPage, fetchDetail])

  const handleDetailPageChange = useCallback((page: number) => {
    setDetailPage(page)
  }, [])

  // Derive totals from summary rows. billableInputTokens is already computed
  // per row server-side with the right provider multiplier, so summing them
  // is correct even when rows span multiple providers.
  const totals = useMemo(() => {
    return summaryRows.reduce(
      (acc, r) => ({
        inputTokens: acc.inputTokens + r.inputTokens,
        outputTokens: acc.outputTokens + r.outputTokens,
        totalTokens: acc.totalTokens + r.totalTokens,
        cacheReadTokens: acc.cacheReadTokens + (r.cacheReadTokens ?? 0),
        cacheWriteTokens: acc.cacheWriteTokens + (r.cacheWriteTokens ?? 0),
        billableInputTokens: acc.billableInputTokens + (r.billableInputTokens ?? 0),
        calls: acc.calls + r.count,
      }),
      { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, billableInputTokens: 0, calls: 0 },
    )
  }, [summaryRows])

  return (
    <div className="space-y-6">
      {/* Header + Period selector */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">{t('settings.tokenUsage.title')}</h3>
          <p className="text-sm text-muted-foreground">{t('settings.tokenUsage.description')}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {PERIODS.map((p) => (
            <Button
              key={p}
              size="sm"
              variant={period === p ? 'secondary' : 'ghost'}
              className="h-7 px-2.5 text-xs"
              onClick={() => setPeriod(p)}
            >
              {t(`settings.tokenUsage.period${p === '24h' ? '24h' : p === '7d' ? '7d' : p === '30d' ? '30d' : 'All'}`)}
            </Button>
          ))}
        </div>
      </div>

      {/* Summary Cards */}
      <SummaryCards data={totals} loading={loading} t={t} />

      {/* Daily Sparkline */}
      {!loading && dailyData.length > 1 && (
        <DailySparkline data={dailyData} t={t} />
      )}

      {/* Group by — toggle buttons */}
      <div className="space-y-1.5">
        <span className="text-xs text-muted-foreground">{t('settings.tokenUsage.groupBy')}</span>
        <div className="flex flex-wrap items-center gap-1">
          {GROUP_OPTIONS.map((opt) => (
            <Button
              key={opt}
              size="sm"
              variant={groupBy === opt ? 'secondary' : 'ghost'}
              className="h-7 px-2.5 text-xs"
              onClick={() => setGroupBy(opt)}
            >
              {t(`settings.tokenUsage.groupBy${opt === 'provider_type' ? 'Provider' : opt === 'model_id' ? 'Model' : opt === 'kin_id' ? 'Kin' : opt === 'call_site' ? 'CallSite' : 'Day'}`)}
            </Button>
          ))}
        </div>
      </div>

      {/* Filters — dropdowns */}
      {(kinFilterOptions.length > 0 || providerOptions.length > 0) && (
        <div className="space-y-1.5">
          <span className="text-xs text-muted-foreground">{t('settings.tokenUsage.filters')}</span>
          <div className="flex flex-wrap items-center gap-2">
            {kinFilterOptions.length > 0 && (
              <KinFilter value={kinFilter} onValueChange={setKinFilter} kins={kinFilterOptions} t={t} />
            )}
            {providerOptions.length > 0 && (
              <ProviderFilter value={providerFilter} onValueChange={setProviderFilter} providers={providerOptions} t={t} />
            )}
          </div>
        </div>
      )}

      {/* Breakdown Table */}
      <BreakdownTable rows={summaryRows} loading={loading} groupBy={groupBy} kinMap={kinMap} t={t} />

      {/* Detail Table — individual requests */}
      <div className="space-y-1.5">
        <h4 className="text-sm font-medium">{t('settings.tokenUsage.detailTitle')}</h4>
        <DetailTable
          rows={detailRows}
          loading={detailLoading}
          page={detailPage}
          totalCount={detailCount}
          onPageChange={handleDetailPageChange}
          kinMap={kinMap}
          t={t}
        />
      </div>
    </div>
  )
}
