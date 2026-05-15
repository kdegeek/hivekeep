import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useTicket, useTickets } from '@/client/hooks/useTickets'
import { useProject } from '@/client/hooks/useProjects'
import { Button } from '@/client/components/ui/button'
import { Badge } from '@/client/components/ui/badge'
import { Play, ListChecks, Loader2, X, ChevronLeft, Pencil } from 'lucide-react'
import { EmptyState } from '@/client/components/common/EmptyState'
import { MarkdownContent } from '@/client/components/chat/MarkdownContent'
import { TaskTimelineItem } from '@/client/components/common/TaskTimelineItem'
import { useSidePanel } from '@/client/contexts/SidePanelContext'
import { formatRelativeTime } from '@/client/lib/time'
import { StartTaskDialog } from '@/client/components/project/StartTaskDialog'
import { EditTicketModal } from '@/client/components/project/EditTicketModal'
import { TicketReporterBadge } from '@/client/components/project/TicketReporterBadge'
import { getErrorMessage } from '@/client/lib/api'
import { toast } from 'sonner'
import type { TicketTaskSummary } from '@/shared/types'

interface TicketPanelContentProps {
  ticketId: string
}

const STATUS_LABEL_KEYS: Record<string, string> = {
  backlog: 'projects.status.backlog',
  todo: 'projects.status.todo',
  in_progress: 'projects.status.in_progress',
  blocked: 'projects.status.blocked',
  done: 'projects.status.done',
}

export function TicketPanelContent({ ticketId }: TicketPanelContentProps) {
  const { t } = useTranslation()
  const { ticket, isLoading } = useTicket(ticketId)
  const { project } = useProject(ticket?.projectId ?? null)
  const { updateTicket, deleteTicket } = useTickets(ticket?.projectId ?? null)
  const { closeTicket, activeTicket, openTask } = useSidePanel()
  const [startTaskOpen, setStartTaskOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)

  const parent = activeTicket?.parent

  if (isLoading && !ticket) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    )
  }

  if (!ticket) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm text-muted-foreground">{t('projects.ticket.panel.notFound')}</p>
        <Button variant="ghost" onClick={closeTicket}>
          {t('common.close')}
        </Button>
      </div>
    )
  }

  function handleTaskClick(task: TicketTaskSummary) {
    openTask({
      taskId: task.id,
      kinName: task.parentKinName,
      parent: { type: 'ticket', id: ticket!.id },
    })
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        {parent && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => {
              if (parent.type === 'task') {
                openTask({ taskId: parent.id })
              }
            }}
            title={t('projects.ticket.panel.back', { type: parent.type })}
          >
            <ChevronLeft className="size-4" />
          </Button>
        )}
        <h2 className="flex-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('projects.ticket.panel.heading')}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => setEditOpen(true)}
          title={t('projects.ticket.panel.editAction')}
        >
          <Pencil className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={closeTicket}
          title={t('common.close')}
        >
          <X className="size-3.5" />
        </Button>
      </header>

      {/* Body — read-only */}
      <div className="flex-1 overflow-y-auto p-3">
        {/* Title */}
        <h1 className="mb-2 text-base font-semibold leading-tight">{ticket.title}</h1>

        {/* Reporter (created by ...) + created date */}
        {(ticket.reporter || ticket.createdAt) && (
          <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{t('projects.reporter.label')}</span>
            {ticket.reporter ? (
              <TicketReporterBadge reporter={ticket.reporter} variant="full" />
            ) : (
              <span className="italic">{t('projects.reporter.unknown')}</span>
            )}
            <span>·</span>
            <span>{formatRelativeTime(ticket.createdAt)}</span>
          </div>
        )}

        {/* Status + tags */}
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="text-xs">
            {t(STATUS_LABEL_KEYS[ticket.status] ?? ticket.status)}
          </Badge>
          {ticket.tags.map((tag) => (
            <Badge
              key={tag.id}
              variant="secondary"
              className="px-1.5 py-0 text-[10px] font-normal"
              style={{
                backgroundColor: `${tag.color}20`,
                color: tag.color,
                borderColor: `${tag.color}40`,
              }}
            >
              {tag.label}
            </Badge>
          ))}
        </div>

        {/* Description */}
        <section className="mb-4">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t('projects.ticket.panel.description')}
          </h3>
          {ticket.description.trim() ? (
            <div className="text-sm text-foreground">
              <MarkdownContent content={ticket.description} isUser={false} />
            </div>
          ) : (
            <p className="text-sm italic text-muted-foreground">
              {t('projects.ticket.panel.noDescription')}
            </p>
          )}
        </section>

        {/* Tasks history */}
        <section>
          <header className="mb-2 flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <ListChecks className="size-3.5" />
              {t('projects.ticket.panel.tasksHistory', { count: ticket.tasks.length })}
            </h3>
            <Button size="sm" onClick={() => setStartTaskOpen(true)}>
              <Play className="mr-1 size-3" />
              {t('projects.ticket.panel.startTask')}
            </Button>
          </header>

          {ticket.tasks.length === 0 ? (
            <EmptyState
              compact
              icon={Play}
              title={t('projects.ticket.panel.noTasksTitle')}
              description={t('projects.ticket.panel.noTasksDescription')}
              actionLabel={t('projects.ticket.panel.startTask')}
              onAction={() => setStartTaskOpen(true)}
            />
          ) : (
            <ul className="space-y-0">
              {ticket.tasks.map((task, i) => (
                <li key={task.id}>
                  <TaskTimelineItem
                    status={task.status}
                    primary={task.parentKinName}
                    secondary={t(`projects.taskStatus.${task.status}`, { defaultValue: task.status })}
                    time={formatRelativeTime(task.createdAt)}
                    isLast={i === ticket.tasks.length - 1}
                    onClick={() => handleTaskClick(task)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <StartTaskDialog
        open={startTaskOpen}
        onOpenChange={setStartTaskOpen}
        ticketId={ticket.id}
        projectId={ticket.projectId}
      />

      {project && (
        <EditTicketModal
          open={editOpen}
          onOpenChange={setEditOpen}
          ticket={ticket}
          availableTags={project.tags}
          onSave={async (input) => {
            try {
              await updateTicket(ticket.id, input)
            } catch (err) {
              toast.error(getErrorMessage(err))
              throw err
            }
          }}
          onDelete={async () => {
            await deleteTicket(ticket.id)
            closeTicket()
          }}
        />
      )}
    </div>
  )
}
