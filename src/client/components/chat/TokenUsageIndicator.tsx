import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Zap } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/client/components/ui/popover'
import { computeCacheHitRate, computeFreshInput, computeNonCacheInput } from '@/shared/billing'
import type { MessageTokenUsage, TaskTokenUsage } from '@/shared/types'

interface TokenUsageIndicatorProps {
  tokenUsage: MessageTokenUsage | TaskTokenUsage
  /** Optional popover title override. Defaults to "Token usage" — the
   *  task-level reading uses "Task total" instead so the user can tell apart a
   *  per-message badge from the running task total when both surface in the
   *  task panel. */
  title?: string
  /** Optional one-line hint under the popover title (e.g. "X LLM calls").
   *  Skipped when absent. */
  subtitle?: string
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toLocaleString()
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

export const TokenUsageIndicator = memo(function TokenUsageIndicator({ tokenUsage, title, subtitle }: TokenUsageIndicatorProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const fresh = computeFreshInput(tokenUsage)
  const cacheRead = tokenUsage.cacheReadTokens ?? 0
  const cacheWrite = tokenUsage.cacheWriteTokens ?? 0
  const nonCache = computeNonCacheInput(tokenUsage)
  const hitRate = computeCacheHitRate(tokenUsage)
  const hasCache = cacheRead > 0 || cacheWrite > 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5',
            'text-[10px] font-medium tabular-nums',
            'bg-primary/10 text-primary hover:bg-primary/18',
            'transition-colors duration-150',
          )}
          title={t('chat.tokenUsage.headlineHint', 'Real token counts. Click for the full breakdown.')}
        >
          <Zap className="size-2.5" />
          <span>↓ {formatTokenCount(tokenUsage.inputTokens)} · ↑ {formatTokenCount(tokenUsage.outputTokens)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-72 p-3"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-3 text-xs">
          {/* Headline: cache hit vs non-cache split */}
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 font-medium text-foreground">
              <Zap className="size-3 text-primary" />
              {title ?? t('chat.tokenUsage.usageTitle', 'Token usage')}
            </div>
            {subtitle && (
              <div className="text-[10px] text-muted-foreground leading-snug">{subtitle}</div>
            )}
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 tabular-nums">
              {hasCache && (
                <>
                  <span className="text-muted-foreground">{t('chat.tokenUsage.cacheHitInput', 'Cache hit')}</span>
                  <span className="text-right font-semibold text-success">{formatTokenCount(cacheRead)}</span>
                  <span className="text-muted-foreground">{t('chat.tokenUsage.nonCacheInput', 'Non-cache')}</span>
                  <span className="text-right font-semibold text-foreground">{formatTokenCount(nonCache)}</span>
                </>
              )}
              {!hasCache && (
                <>
                  <span className="text-muted-foreground">{t('chat.tokenUsage.input')}</span>
                  <span className="text-right font-semibold text-foreground">{formatTokenCount(tokenUsage.inputTokens)}</span>
                </>
              )}
              <span className="text-muted-foreground">{t('chat.tokenUsage.output')}</span>
              <span className="text-right font-semibold text-foreground">{formatTokenCount(tokenUsage.outputTokens)}</span>
            </div>
          </div>

          {/* Raw breakdown */}
          <div className="space-y-1 border-t border-border/50 pt-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
              {t('chat.tokenUsage.rawBreakdown', 'Raw breakdown')}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted-foreground tabular-nums">
              <span>{t('chat.tokenUsage.inputGross', 'Input (gross)')}</span>
              <span className="text-right text-foreground">{formatTokenCount(tokenUsage.inputTokens)}</span>
              {hasCache && (
                <>
                  <span className="pl-2">↳ {t('chat.tokenUsage.fresh', 'fresh')}</span>
                  <span className="text-right text-foreground">{formatTokenCount(fresh)}</span>
                </>
              )}
              {cacheWrite > 0 && (
                <>
                  <span className="pl-2">↳ {t('chat.tokenUsage.cacheWrite')}</span>
                  <span className="text-right text-foreground">{formatTokenCount(cacheWrite)}</span>
                </>
              )}
              {cacheRead > 0 && (
                <>
                  <span className="pl-2">↳ {t('chat.tokenUsage.cacheRead')}</span>
                  <span className="text-right text-foreground">{formatTokenCount(cacheRead)}</span>
                </>
              )}
              <span>{t('chat.tokenUsage.output')}</span>
              <span className="text-right text-foreground">{formatTokenCount(tokenUsage.outputTokens)}</span>
              {(tokenUsage.reasoningTokens ?? 0) > 0 && (
                <>
                  <span>{t('chat.tokenUsage.reasoning')}</span>
                  <span className="text-right text-foreground">{formatTokenCount(tokenUsage.reasoningTokens!)}</span>
                </>
              )}
              {hasCache && (
                <>
                  <span>{t('chat.tokenUsage.cacheHit', 'Cache hit')}</span>
                  <span className={cn(
                    'text-right font-semibold',
                    hitRate >= 0.7 ? 'text-success' : hitRate >= 0.3 ? 'text-warning' : 'text-muted-foreground',
                  )}>{formatPercent(hitRate)}</span>
                </>
              )}
              {(tokenUsage.stepCount ?? 1) > 1 && (
                <>
                  <span>{t('chat.tokenUsage.steps', { count: tokenUsage.stepCount })}</span>
                  <span className="text-right text-foreground">{tokenUsage.stepCount}</span>
                </>
              )}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
})
