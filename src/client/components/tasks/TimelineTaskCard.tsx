import { TaskCard, type TaskCardModel } from '@/client/components/tasks/TaskCard'
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

/**
 * Tasks-page adapter: maps a `TaskSummary` onto the shared {@link TaskCard}
 * view-model. `isLast` is accepted for call-site compatibility but unused — the
 * previous timeline rail was replaced by discrete cards.
 */
export function TimelineTaskCard({
  task,
  onClick,
  queuePosition,
  nowMs,
}: {
  task: TaskSummary
  onClick: () => void
  isLast?: boolean
  queuePosition?: number
  nowMs: number
}) {
  const model: TaskCardModel = {
    id: task.id,
    status: task.status,
    title: task.title ?? task.description,
    agentName: task.sourceAgentName ?? task.parentAgentName,
    avatarUrl: task.sourceAgentAvatarUrl ?? task.parentAgentAvatarUrl,
    startedMs: task.startedAt ? new Date(task.startedAt).getTime() : null,
    endedMs: task.endedAt ? new Date(task.endedAt).getTime() : null,
    createdMs: new Date(task.createdAt).getTime(),
    model: task.model,
    providerType: task.providerType,
    thinkingEnabled: task.thinkingEnabled,
    thinkingEffort: task.thinkingEffort,
    cronId: task.cronId,
    depth: task.depth,
    concurrencyGroup: task.concurrencyGroup,
    tokenUsage: task.tokenUsage,
  }

  return <TaskCard task={model} onClick={onClick} queuePosition={queuePosition} nowMs={nowMs} />
}
