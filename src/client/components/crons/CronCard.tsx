import { useTranslation } from 'react-i18next'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/components/ui/avatar'
import { Badge } from '@/client/components/ui/badge'
import { Button } from '@/client/components/ui/button'
import { Switch } from '@/client/components/ui/switch'
import { useAuth } from '@/client/hooks/useAuth'
import { cn } from '@/client/lib/utils'
import { formatRelativeTime } from '@/client/lib/time'
import { cronToHuman } from '@/client/lib/cron-human'
import { cronNextRun, formatCountdown } from '@/client/lib/cron-next'
import { Clock, CheckCircle2, Loader2, GripVertical, FastForward, Bell } from 'lucide-react'
import type { CronSummary } from '@/shared/types'

export function CronCard({
  cron,
  onClick,
  onApprove,
  onToggleActive,
  isRunning,
}: {
  cron: CronSummary
  onClick: () => void
  onApprove?: () => void
  onToggleActive?: (isActive: boolean) => void
  isRunning?: boolean
}) {
  const { t, i18n } = useTranslation()
  const { user } = useAuth()
  const serverTimezone = user?.serverTimezone
  const initials = cron.kinName.slice(0, 2).toUpperCase()
  const isPaused = !cron.isActive && !cron.requiresApproval
  const humanSchedule = cronToHuman(cron.schedule, i18n.language)
  const nextRun = cron.isActive && !cron.requiresApproval ? cronNextRun(cron.schedule, serverTimezone) : null

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick() }}
      className={cn(
        'flex items-center gap-3 rounded-lg bg-sidebar-accent/30 px-3 py-2.5 text-xs hover:bg-sidebar-accent/50 transition-colors cursor-pointer',
        isPaused && 'opacity-60',
      )}
    >
      <Avatar className="size-7 shrink-0">
        {cron.kinAvatarUrl && <AvatarImage src={cron.kinAvatarUrl} alt={cron.kinName} />}
        <AvatarFallback className="text-[10px] bg-secondary">{initials}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <p className="truncate font-medium text-foreground">{cron.name}</p>
          {cron.triggerParentTurn && (
            <Bell className="size-3 shrink-0 text-chart-4" aria-label={t('cron.triggerParentTurn.badge')}>
              <title>{t('cron.triggerParentTurn.badge')}</title>
            </Bell>
          )}
          {isRunning && <Loader2 className="size-3 shrink-0 animate-spin text-primary" />}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <Clock className="size-3 shrink-0 text-muted-foreground" />
          <span className="text-[10px] text-muted-foreground truncate" title={cron.schedule}>
            {humanSchedule ?? cron.schedule}
          </span>
          {cron.runOnce && (
            <Badge variant="outline" className="ml-1 h-4 px-1 text-[9px] text-info border-info/40">
              {t('cron.detail.oneTime', 'One-time')}
            </Badge>
          )}
          {cron.requiresApproval && (
            <Badge variant="outline" className="ml-1 h-4 px-1 text-[9px] text-warning border-warning/40">
              {t('sidebar.crons.pendingApproval')}
            </Badge>
          )}
          {nextRun && (
            <span className="text-[10px] text-primary/70 ml-auto shrink-0 flex items-center gap-0.5" title={t('sidebar.crons.nextRun', { time: nextRun.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}>
              <FastForward className="size-2.5" />
              {formatCountdown(nextRun)}
            </span>
          )}
          {!nextRun && cron.lastTriggeredAt && (
            <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
              {formatRelativeTime(cron.lastTriggeredAt)}
            </span>
          )}
        </div>
      </div>
      {cron.requiresApproval && onApprove && (
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          onClick={(e) => {
            e.stopPropagation()
            onApprove()
          }}
          title={t('sidebar.crons.approve')}
        >
          <CheckCircle2 className="size-3.5 text-success" />
        </Button>
      )}
      {!cron.requiresApproval && onToggleActive && (
        <Switch
          checked={cron.isActive}
          onCheckedChange={(checked) => onToggleActive(checked)}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 scale-75"
        />
      )}
    </div>
  )
}

export function SortableCronCard({
  cron,
  onClick,
  onToggleActive,
  isRunning,
}: {
  cron: CronSummary
  onClick: () => void
  onToggleActive?: (isActive: boolean) => void
  isRunning?: boolean
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: cron.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div ref={setNodeRef} style={style} className="relative group">
      <div
        {...attributes}
        {...listeners}
        className="absolute left-0 top-0 z-10 flex h-full w-5 cursor-grab items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className="size-3 text-muted-foreground" />
      </div>
      <CronCard
        cron={cron}
        onClick={onClick}
        onToggleActive={onToggleActive}
        isRunning={isRunning}
      />
    </div>
  )
}
