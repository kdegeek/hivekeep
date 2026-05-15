import type { ReactNode } from 'react'
import { Loader2, CheckCircle2, XCircle, Clock, Ban, UserCheck, MessageSquare, Pause, ListOrdered } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import type { TaskStatus } from '@/shared/types'

/**
 * Visual config for each task status — single source of truth used by every
 * timeline-style task list (sidebar tasks tab, ticket detail panel, etc.).
 */
export const TASK_STATUS_CONFIG: Record<TaskStatus, {
  icon: typeof Clock
  iconClass: string
  dotClass: string
  ringClass: string
}> = {
  queued: {
    icon: ListOrdered,
    iconClass: 'text-orange-500',
    dotClass: 'bg-orange-500/30',
    ringClass: 'ring-orange-500/15',
  },
  pending: {
    icon: Clock,
    iconClass: 'text-muted-foreground',
    dotClass: 'bg-muted-foreground/50',
    ringClass: 'ring-muted-foreground/20',
  },
  in_progress: {
    icon: Loader2,
    iconClass: 'text-primary animate-spin',
    dotClass: 'bg-primary',
    ringClass: 'ring-primary/30',
  },
  paused: {
    icon: Pause,
    iconClass: 'text-amber-500',
    dotClass: 'bg-amber-500/50',
    ringClass: 'ring-amber-500/20',
  },
  awaiting_human_input: {
    icon: UserCheck,
    iconClass: 'text-warning animate-pulse',
    dotClass: 'bg-warning animate-pulse',
    ringClass: 'ring-warning/30',
  },
  awaiting_kin_response: {
    icon: MessageSquare,
    iconClass: 'text-info animate-pulse',
    dotClass: 'bg-info animate-pulse',
    ringClass: 'ring-info/30',
  },
  completed: {
    icon: CheckCircle2,
    iconClass: 'text-success',
    dotClass: 'bg-success',
    ringClass: 'ring-success/20',
  },
  failed: {
    icon: XCircle,
    iconClass: 'text-destructive',
    dotClass: 'bg-destructive',
    ringClass: 'ring-destructive/20',
  },
  cancelled: {
    icon: Ban,
    iconClass: 'text-muted-foreground',
    dotClass: 'bg-muted-foreground/40',
    ringClass: 'ring-muted-foreground/10',
  },
}

export interface TaskTimelineItemProps {
  status: TaskStatus
  /** Main label — task title for the sidebar list, Kin name for the ticket panel. */
  primary: ReactNode
  /** Optional secondary text under primary (typically Kin name or status). */
  secondary?: ReactNode
  /** Pre-formatted time/duration label shown on the right of the meta row. */
  time: ReactNode
  /** Last item in the timeline — omits the trailing rail line. */
  isLast?: boolean
  /** Small prefix in front of primary (e.g. queue position "#3"). */
  prefix?: ReactNode
  onClick?: () => void
}

/**
 * Generic timeline-style task entry: vertical rail with status dot on the left,
 * card with title + (status icon + secondary + time) on the right. Used by the
 * sidebar tasks tab and the ticket detail panel so the visual stays consistent.
 */
export function TaskTimelineItem({
  status,
  primary,
  secondary,
  time,
  isLast,
  prefix,
  onClick,
}: TaskTimelineItemProps) {
  const config = TASK_STATUS_CONFIG[status]
  const Icon = config.icon
  const isCancelled = status === 'cancelled'
  const isQueued = status === 'queued'
  const isActive =
    status === 'in_progress' ||
    status === 'paused' ||
    status === 'awaiting_human_input' ||
    status === 'awaiting_kin_response' ||
    status === 'pending'

  return (
    <div className="relative flex gap-3 group">
      {/* Timeline rail */}
      <div className="flex flex-col items-center shrink-0 w-4">
        <div
          className={cn(
            'relative z-10 mt-2.5 size-2.5 rounded-full ring-2',
            config.dotClass,
            config.ringClass,
            isActive && 'size-3',
          )}
        />
        {!isLast && <div className="flex-1 w-px bg-border/60 mt-1" />}
      </div>

      {/* Card */}
      <div
        role={onClick ? 'button' : undefined}
        tabIndex={onClick ? 0 : undefined}
        onClick={onClick}
        onKeyDown={onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick()
              }
            }
          : undefined}
        className={cn(
          'flex-1 min-w-0 rounded-lg px-2.5 py-2 mb-1 text-xs transition-colors',
          onClick && 'cursor-pointer hover:bg-sidebar-accent/40',
          isActive && 'bg-sidebar-accent/30',
          isQueued && 'opacity-70',
          isCancelled && 'opacity-50',
        )}
      >
        <p className="truncate font-medium text-foreground text-[11px] leading-tight">
          {prefix != null && <span className="text-muted-foreground mr-1">{prefix}</span>}
          {primary}
        </p>
        <div className="flex items-center gap-1.5 mt-1">
          <Icon className={cn('size-3 shrink-0', config.iconClass)} />
          {secondary != null && (
            <span className="text-[10px] text-muted-foreground truncate">{secondary}</span>
          )}
          <span className="text-[10px] text-muted-foreground ml-auto shrink-0 tabular-nums">
            {time}
          </span>
        </div>
      </div>
    </div>
  )
}
