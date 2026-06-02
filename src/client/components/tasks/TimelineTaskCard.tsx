import { Zap } from 'lucide-react'
import { formatDurationMs, computeDurationMs } from '@/client/lib/time'
import { TaskTimelineItem } from '@/client/components/common/TaskTimelineItem'
import { isQueuedStatus, isTerminalStatus } from '@/client/lib/task-status'
import type { TaskSummary } from '@/shared/types'

/** Group tasks by day, returning [label, tasks][] */
export function groupByDay(
  tasks: TaskSummary[],
  t: (key: string) => string,
): [string, TaskSummary[]][] {
  const now = new Date()
  const todayStr = now.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayStr = yesterday.toDateString()

  const groups = new Map<string, { label: string; tasks: TaskSummary[] }>()

  for (const task of tasks) {
    const date = new Date(task.createdAt)
    const dateStr = date.toDateString()

    let label: string
    if (dateStr === todayStr) {
      label = t('chat.dateSeparator.today')
    } else if (dateStr === yesterdayStr) {
      label = t('chat.dateSeparator.yesterday')
    } else {
      label = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    }

    const key = dateStr
    if (!groups.has(key)) {
      groups.set(key, { label, tasks: [] })
    }
    groups.get(key)!.tasks.push(task)
  }

  return Array.from(groups.values()).map((g) => [g.label, g.tasks])
}

function formatTime(isoDate: string): string {
  return new Date(isoDate).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toLocaleString()
}

function TokenChip({ headline }: { headline: number }) {
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 text-primary px-1.5 py-px text-[9px] font-medium tabular-nums"
      title={`≈ ${headline.toLocaleString()} tokens`}
    >
      <Zap className="size-2" />
      ≈ {formatTokenCount(headline)}
    </span>
  )
}

/**
 * One task row rendered as a timeline item. Shared by the Tasks page columns.
 * Run duration ticks live off the shared `nowMs` clock while executing and
 * freezes at `endedAt` once terminal.
 */
export function TimelineTaskCard({
  task,
  onClick,
  isLast,
  queuePosition,
  nowMs,
}: {
  task: TaskSummary
  onClick: () => void
  isLast: boolean
  queuePosition?: number
  nowMs: number
}) {
  const kinName = task.sourceKinName ?? task.parentKinName
  const isQueued = isQueuedStatus(task.status)
  const isFinished = isTerminalStatus(task.status)

  const startedMs = task.startedAt ? new Date(task.startedAt).getTime() : null
  const endedMs = task.endedAt ? new Date(task.endedAt).getTime() : null
  const runMs = computeDurationMs(startedMs, isFinished ? endedMs : null, nowMs)
  const runDuration = runMs != null ? formatDurationMs(runMs) : null

  const primary = task.title ?? (task.description.length > 55
    ? task.description.slice(0, 55) + '…'
    : task.description)
  const secondary = isQueued && task.concurrencyGroup ? task.concurrencyGroup : kinName
  const time = runDuration != null ? runDuration : formatTime(task.createdAt)

  const usage = task.tokenUsage
  const tokenHeadline = usage ? usage.billableInputTokens + usage.outputTokens : 0

  return (
    <TaskTimelineItem
      status={task.status}
      primary={primary}
      secondary={secondary}
      time={time}
      isLast={isLast}
      prefix={isQueued && queuePosition != null ? `#${queuePosition}` : undefined}
      trailing={tokenHeadline > 0 ? <TokenChip headline={tokenHeadline} /> : undefined}
      onClick={onClick}
    />
  )
}
