import { useState, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { Progress } from '@/client/components/ui/progress'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/client/components/ui/tooltip'
import { MessageSquare, Wrench, Archive, AlertTriangle } from 'lucide-react'
import type { ContextTokenBreakdown, ContextPipelineStatus } from '@/shared/types'

const ContextViewerDialog = lazy(() =>
  import('@/client/components/chat/ContextViewerDialog').then((m) => ({ default: m.ContextViewerDialog })),
)

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

interface ContextBarProps {
  kinId: string
  estimatedTokens: number
  maxTokens: number
  /** 'api' = ground-truth from last LLM call, 'estimate' = local BPE
   *  estimate (used before any API roundtrip exists for the session). */
  contextSource?: 'api' | 'estimate'
  contextBreakdown?: ContextTokenBreakdown
  pipelineStatus?: ContextPipelineStatus
  compactingPercent?: number
  compactingThresholdPercent?: number
  summaryCount?: number
  maxSummaries?: number
  summaryTokens?: number
  summaryBudgetTokens?: number
  messageCount?: number
  /** Compact mode: smaller width, no compacting proximity line */
  compact?: boolean
  /** If set, context preview will show the task's context instead of the main conversation */
  taskId?: string
  /** If set, context preview will show the quick session's context */
  sessionId?: string
}

export function ContextBar({
  kinId,
  estimatedTokens,
  maxTokens,
  contextSource,
  contextBreakdown,
  pipelineStatus,
  compactingPercent: compactingPct,
  compactingThresholdPercent,
  summaryCount,
  maxSummaries,
  summaryTokens,
  summaryBudgetTokens,
  messageCount,
  compact = false,
  taskId,
  sessionId,
}: ContextBarProps) {
  const { t } = useTranslation()
  const [contextViewerOpen, setContextViewerOpen] = useState(false)

  const hasContextData = maxTokens > 0
  // estimatedTokens is the displayed total — provider-reported when available
  // (contextSource='api'), otherwise our local BPE estimate. The colored
  // breakdown blocks below always come from the LOCAL estimator (providers
  // don't return per-section sizes), so they may not sum to estimatedTokens
  // when the source is 'api' — the visible gap is the estimator's blind spot.
  const breakdownSum = contextBreakdown
    ? contextBreakdown.tools + contextBreakdown.systemPrompt + (contextBreakdown.summary ?? 0)
      + (contextBreakdown.cronRuns ?? 0) + (contextBreakdown.cronLearnings ?? 0) + contextBreakdown.messages
    : 0
  const realValueAvailable = contextSource === 'api' && hasContextData
  const realValuePercent = realValueAvailable ? Math.min(100, (estimatedTokens / maxTokens) * 100) : 0
  const breakdownPercent = hasContextData && breakdownSum > 0 ? Math.min(100, (breakdownSum / maxTokens) * 100) : 0
  const contextPercent = hasContextData ? Math.min(100, Math.round((estimatedTokens / maxTokens) * 100)) : 0
  const contextLabel = hasContextData
    ? `${formatTokenCount(estimatedTokens)} / ${formatTokenCount(maxTokens)}`
    : '— / —'

  const hasCompactingData = (compactingThresholdPercent ?? 0) > 0
  const compactingPercent = compactingPct ?? 0

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={`flex cursor-pointer flex-col gap-1 rounded-md px-1 transition-colors hover:bg-muted/50 min-w-0 ${compact ? 'w-40' : 'w-56'}`}
            onClick={() => setContextViewerOpen(true)}
          >
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              {messageCount != null && (
                <span className="flex items-center gap-1">
                  <MessageSquare className="size-3" />
                  {messageCount}
                </span>
              )}
              <span className="flex items-center gap-1">
                {contextSource === 'estimate' && (
                  <span
                    className="rounded bg-muted px-1 py-px text-[9px] font-medium text-muted-foreground/80"
                    title={t('chat.contextSource.estimateHint', { defaultValue: 'Local BPE estimate — switches to ground-truth after the first LLM call.' })}
                  >
                    ~
                  </span>
                )}
                {contextSource === 'api' && (
                  <span
                    className="rounded bg-success/15 px-1 py-px text-[9px] font-medium text-success"
                    title={t('chat.contextSource.apiHint', { defaultValue: 'Reported by the provider on the last call (ground truth).' })}
                  >
                    ✓
                  </span>
                )}
                <span>{contextLabel}</span>
              </span>
            </div>
            <div className="relative">
              {contextBreakdown && hasContextData ? (
                <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-primary/20">
                  {contextBreakdown.tools > 0 && (
                    <div className="bg-blue-500" style={{ width: `${Math.max(0.5, (contextBreakdown.tools / maxTokens) * 100)}%` }} />
                  )}
                  {contextBreakdown.systemPrompt > 0 && (
                    <div className="bg-purple-500" style={{ width: `${Math.max(0.5, (contextBreakdown.systemPrompt / maxTokens) * 100)}%` }} />
                  )}
                  {(contextBreakdown.summary ?? 0) > 0 && (
                    <div className="bg-amber-500" style={{ width: `${Math.max(0.5, (contextBreakdown.summary! / maxTokens) * 100)}%` }} />
                  )}
                  {(contextBreakdown.cronRuns ?? 0) > 0 && (
                    <div className="bg-orange-500" style={{ width: `${Math.max(0.5, (contextBreakdown.cronRuns! / maxTokens) * 100)}%` }} />
                  )}
                  {(contextBreakdown.cronLearnings ?? 0) > 0 && (
                    <div className="bg-teal-500" style={{ width: `${Math.max(0.5, (contextBreakdown.cronLearnings! / maxTokens) * 100)}%` }} />
                  )}
                  {contextBreakdown.messages > 0 && (
                    <div className="bg-emerald-500" style={{ width: `${Math.max(0.5, (contextBreakdown.messages / maxTokens) * 100)}%` }} />
                  )}
                  {/* "Non attribué" segment: gap between estimate sum and the
                       provider-reported real value. Shown as a hatched gray
                       fill so the user sees that the bar IS at the real
                       position but we can't break down the extra portion. */}
                  {realValueAvailable && realValuePercent > breakdownPercent + 0.5 && (
                    <div
                      className="bg-muted-foreground/30"
                      style={{
                        width: `${realValuePercent - breakdownPercent}%`,
                        backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(255,255,255,0.15) 2px, rgba(255,255,255,0.15) 4px)',
                      }}
                      title={t('chat.contextSource.unattributedHint', { defaultValue: 'Provider-reported size beyond what the local estimator can attribute by section.' })}
                    />
                  )}
                </div>
              ) : (
                <Progress
                  value={contextPercent}
                  variant={contextPercent > 80 ? 'glow' : 'default'}
                  className="h-1.5"
                />
              )}
              {hasCompactingData && (
                <div
                  className="absolute top-0 h-full w-px bg-warning"
                  style={{ left: `${compactingThresholdPercent}%` }}
                />
              )}
              {/* Real (provider-reported) value marker: a small vertical line
                   at the actual context size from the last LLM call. Visually
                   distinct from the compaction threshold (which is amber). */}
              {realValueAvailable && (
                <div
                  className="absolute -top-px h-[calc(100%+2px)] w-0.5 rounded-sm bg-success shadow-[0_0_4px_var(--color-success)]"
                  style={{ left: `calc(${realValuePercent}% - 1px)` }}
                  title={t('chat.contextSource.realMarkerHint', { defaultValue: 'Real context size reported by the provider on the last call.' })}
                />
              )}
            </div>
            {!compact && hasCompactingData && (
              <p className="truncate text-[9px] text-muted-foreground">
                {t('chat.compactingProximity', {
                  percent: compactingPercent,
                  threshold: compactingThresholdPercent ?? 0,
                  summaryCount: summaryCount ?? 0,
                })}
              </p>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" hideArrow className="w-72 space-y-3 border border-border bg-popover p-3 text-popover-foreground shadow-md">
          {/* Context window */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-medium">{t('chat.tooltipContext')}</span>
              <span className="flex items-center gap-1 text-muted-foreground">
                {realValueAvailable && <span className="rounded bg-success/15 px-1 py-px text-[9px] font-medium text-success">✓ {t('chat.contextSource.real', { defaultValue: 'real' })}</span>}
                {!realValueAvailable && hasContextData && <span className="rounded bg-muted px-1 py-px text-[9px] font-medium text-muted-foreground/80">~ {t('chat.contextSource.estimate', { defaultValue: 'est.' })}</span>}
                <span>{contextLabel}</span>
              </span>
            </div>
            <div className="relative">
              {contextBreakdown && hasContextData ? (
                <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-primary/20">
                  {contextBreakdown.tools > 0 && (
                    <div className="bg-blue-500" style={{ width: `${Math.max(0.5, (contextBreakdown.tools / maxTokens) * 100)}%` }} />
                  )}
                  {contextBreakdown.systemPrompt > 0 && (
                    <div className="bg-purple-500" style={{ width: `${Math.max(0.5, (contextBreakdown.systemPrompt / maxTokens) * 100)}%` }} />
                  )}
                  {(contextBreakdown.summary ?? 0) > 0 && (
                    <div className="bg-amber-500" style={{ width: `${Math.max(0.5, (contextBreakdown.summary! / maxTokens) * 100)}%` }} />
                  )}
                  {(contextBreakdown.cronRuns ?? 0) > 0 && (
                    <div className="bg-orange-500" style={{ width: `${Math.max(0.5, (contextBreakdown.cronRuns! / maxTokens) * 100)}%` }} />
                  )}
                  {(contextBreakdown.cronLearnings ?? 0) > 0 && (
                    <div className="bg-teal-500" style={{ width: `${Math.max(0.5, (contextBreakdown.cronLearnings! / maxTokens) * 100)}%` }} />
                  )}
                  {contextBreakdown.messages > 0 && (
                    <div className="bg-emerald-500" style={{ width: `${Math.max(0.5, (contextBreakdown.messages / maxTokens) * 100)}%` }} />
                  )}
                  {realValueAvailable && realValuePercent > breakdownPercent + 0.5 && (
                    <div
                      className="bg-muted-foreground/30"
                      style={{
                        width: `${realValuePercent - breakdownPercent}%`,
                        backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(255,255,255,0.15) 2px, rgba(255,255,255,0.15) 4px)',
                      }}
                    />
                  )}
                </div>
              ) : (
                <Progress
                  value={contextPercent}
                  variant={contextPercent > 80 ? 'glow' : 'default'}
                  className="h-2.5"
                />
              )}
              {hasCompactingData && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div
                      className="absolute top-[-2px] h-[calc(100%+4px)] w-px bg-warning"
                      style={{ left: `${compactingThresholdPercent}%` }}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-[10px]">
                    {t('chat.compactingMarker')} ({compactingThresholdPercent}%)
                  </TooltipContent>
                </Tooltip>
              )}
              {realValueAvailable && (
                <div
                  className="absolute -top-px h-[calc(100%+2px)] w-0.5 rounded-sm bg-success shadow-[0_0_4px_var(--color-success)]"
                  style={{ left: `calc(${realValuePercent}% - 1px)` }}
                />
              )}
            </div>
            {contextBreakdown && hasContextData ? (
              <div className="space-y-1 text-[10px]">
                <div className="text-[9px] uppercase tracking-wide text-muted-foreground/70">
                  {t('chat.breakdown.estimateLabel', { defaultValue: 'Breakdown (local estimate)' })}
                </div>
                <div className="flex items-center justify-between text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block size-2 rounded-sm bg-blue-500" />
                    {t('chat.breakdown.tools', 'Tools')}
                  </span>
                  <span>{formatTokenCount(contextBreakdown.tools)}</span>
                </div>
                <div className="flex items-center justify-between text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block size-2 rounded-sm bg-purple-500" />
                    {t('chat.breakdown.systemPrompt', 'System prompt')}
                  </span>
                  <span>{formatTokenCount(contextBreakdown.systemPrompt)}</span>
                </div>
                {(contextBreakdown.summary ?? 0) > 0 && (
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block size-2 rounded-sm bg-amber-500" />
                      {t('chat.breakdown.summary', 'Summary')}
                    </span>
                    <span>{formatTokenCount(contextBreakdown.summary!)}</span>
                  </div>
                )}
                {(contextBreakdown.cronRuns ?? 0) > 0 && (
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block size-2 rounded-sm bg-orange-500" />
                      {t('chat.breakdown.cronRuns', 'Previous runs')}
                    </span>
                    <span>{formatTokenCount(contextBreakdown.cronRuns!)}</span>
                  </div>
                )}
                {(contextBreakdown.cronLearnings ?? 0) > 0 && (
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block size-2 rounded-sm bg-teal-500" />
                      {t('chat.breakdown.cronLearnings', 'Learnings')}
                    </span>
                    <span>{formatTokenCount(contextBreakdown.cronLearnings!)}</span>
                  </div>
                )}
                <div className="flex items-center justify-between text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block size-2 rounded-sm bg-emerald-500" />
                    {t('chat.breakdown.messages', 'Messages')}
                  </span>
                  <span>{formatTokenCount(contextBreakdown.messages)}</span>
                </div>
                {realValueAvailable && Math.abs(estimatedTokens - breakdownSum) > Math.max(500, breakdownSum * 0.05) && (
                  <div className="flex items-center justify-between text-muted-foreground/80">
                    <span className="flex items-center gap-1.5">
                      <span
                        className="inline-block size-2 rounded-sm bg-muted-foreground/30"
                        style={{
                          backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 1px, rgba(255,255,255,0.2) 1px, rgba(255,255,255,0.2) 2px)',
                        }}
                      />
                      {t('chat.breakdown.unattributed', { defaultValue: 'Unattributed' })}
                    </span>
                    <span>{formatTokenCount(Math.max(0, estimatedTokens - breakdownSum))}</span>
                  </div>
                )}
                <div className="flex items-center justify-between border-t border-border/40 pt-1 text-foreground">
                  {realValueAvailable ? (
                    <>
                      <span className="font-medium flex items-center gap-1">
                        <span className="rounded bg-success/15 px-1 py-px text-[9px] font-medium text-success">✓</span>
                        {t('chat.breakdown.totalReal', { defaultValue: 'Real total' })}
                      </span>
                      <span>{formatTokenCount(estimatedTokens)} / {formatTokenCount(maxTokens)} ({contextPercent}%)</span>
                    </>
                  ) : (
                    <>
                      <span className="font-medium">{t('chat.breakdown.total', 'Total')}</span>
                      <span>{formatTokenCount(contextBreakdown.total)} / {formatTokenCount(maxTokens)} ({contextPercent}%)</span>
                    </>
                  )}
                </div>
                {pipelineStatus && (pipelineStatus.maskedToolGroups > 0 || pipelineStatus.observationCompactedCount > 0 || pipelineStatus.emergencyTrimmedCount > 0) && (
                  <div className="space-y-0.5 border-t border-border/40 pt-1">
                    {pipelineStatus.maskedToolGroups > 0 && (
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <Wrench className="size-2.5 shrink-0" />
                        <span>{t('chat.pipeline.maskedTools', { count: pipelineStatus.maskedToolGroups, tokens: formatTokenCount(pipelineStatus.estimatedTokensSavedByMasking) })}</span>
                      </div>
                    )}
                    {pipelineStatus.observationCompactedCount > 0 && (
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <Archive className="size-2.5 shrink-0" />
                        <span>{t('chat.pipeline.observationCompacted', { count: pipelineStatus.observationCompactedCount })}</span>
                      </div>
                    )}
                    {pipelineStatus.emergencyTrimmedCount > 0 && (
                      <div className="flex items-center gap-1 text-amber-500">
                        <AlertTriangle className="size-2.5 shrink-0" />
                        <span>{t('chat.pipeline.emergencyTrim', { count: pipelineStatus.emergencyTrimmedCount })}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground">
                {hasContextData
                  ? t('chat.contextUsage', {
                      tokens: formatTokenCount(estimatedTokens),
                      max: formatTokenCount(maxTokens),
                      percent: contextPercent,
                    })
                  : t('chat.contextNoData')}
              </p>
            )}
          </div>

          {/* Compacting proximity */}
          {hasCompactingData && (
            <div className="space-y-1.5 border-t border-border/40 pt-2.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-medium">{t('chat.tooltipCompacting')}</span>
                <span className="text-muted-foreground">{compactingPercent}%</span>
              </div>
              <Progress
                value={compactingPercent}
                variant={compactingPercent > 80 ? 'glow' : 'default'}
                className="h-2.5"
              />
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>{t('chat.compactingProximity', {
                  percent: compactingPercent,
                  threshold: compactingThresholdPercent ?? 0,
                  summaryCount: summaryCount ?? 0,
                })}</span>
              </div>
            </div>
          )}

          {/* Summary merge proximity */}
          {(maxSummaries ?? 0) > 0 && (summaryCount ?? 0) > 0 && (
            <div className="space-y-1.5 border-t border-border/40 pt-2.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-medium">{t('chat.tooltipSummaryMerge')}</span>
              </div>
              <div className="space-y-1 text-[10px]">
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>{t('chat.summaryMergeCount', { count: summaryCount ?? 0, max: maxSummaries ?? 0 })}</span>
                </div>
                <Progress
                  value={Math.min(100, Math.round(((summaryCount ?? 0) / (maxSummaries ?? 10)) * 100))}
                  variant={((summaryCount ?? 0) / (maxSummaries ?? 10)) > 0.8 ? 'glow' : 'default'}
                  className="h-1.5"
                />
                {(summaryBudgetTokens ?? 0) > 0 && (
                  <>
                    <div className="flex items-center justify-between text-muted-foreground">
                      <span>{t('chat.summaryMergeBudget', { tokens: formatTokenCount(summaryTokens ?? 0), budget: formatTokenCount(summaryBudgetTokens ?? 0) })}</span>
                    </div>
                    <Progress
                      value={Math.min(100, Math.round(((summaryTokens ?? 0) / (summaryBudgetTokens ?? 1)) * 100))}
                      variant={((summaryTokens ?? 0) / (summaryBudgetTokens ?? 1)) > 0.8 ? 'glow' : 'default'}
                      className="h-1.5"
                    />
                  </>
                )}
              </div>
            </div>
          )}
        </TooltipContent>
      </Tooltip>

      {/* Context viewer dialog */}
      {contextViewerOpen && (
        <Suspense fallback={null}>
          <ContextViewerDialog
            open={contextViewerOpen}
            onOpenChange={setContextViewerOpen}
            kinId={kinId}
            taskId={taskId}
            sessionId={sessionId}
          />
        </Suspense>
      )}
    </>
  )
}
