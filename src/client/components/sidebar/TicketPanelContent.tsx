import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useTicket, useTickets } from '@/client/hooks/useTickets'
import { useProject } from '@/client/hooks/useProjects'
import { Button } from '@/client/components/ui/button'
import { Badge } from '@/client/components/ui/badge'
import { Avatar, AvatarFallback } from '@/client/components/ui/avatar'
import { Play, ListChecks, Loader2, X, ChevronLeft, Pencil } from 'lucide-react'
import { useSidePanel } from '@/client/contexts/SidePanelContext'
import { formatRelativeTime } from '@/client/lib/time'
import { StartTaskDialog } from '@/client/components/project/StartTaskDialog'
import { EditTicketModal } from '@/client/components/project/EditTicketModal'
import { getErrorMessage } from '@/client/lib/api'
import { toast } from 'sonner'
import { cn } from '@/client/lib/utils'
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

const TASK_STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  completed: 'default',
  failed: 'destructive',
  cancelled: 'outline',
  pending: 'secondary',
  in_progress: 'secondary',
  queued: 'secondary',
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
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{ticket.description}</p>
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
            <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
              {t('projects.ticket.panel.noTasks')}
            </p>
          ) : (
            <ul className="space-y-2">
              {ticket.tasks.map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    onClick={() => handleTaskClick(task)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md border border-border p-2 text-left transition-colors hover:bg-muted',
                    )}
                  >
                    <Avatar className="size-6">
                      <AvatarFallback className="text-[10px]">
                        {task.parentKinName.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium">{task.parentKinName}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {formatRelativeTime(task.createdAt)}
                      </div>
                    </div>
                    <Badge
                      variant={TASK_STATUS_VARIANT[task.status] ?? 'secondary'}
                      className="shrink-0 text-[10px]"
                    >
                      {task.status === 'in_progress' && <Loader2 className="mr-1 size-2.5 animate-spin" />}
                      {task.status}
                    </Badge>
                  </button>
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
