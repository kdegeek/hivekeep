import { useTranslation } from 'react-i18next'
import { Kanban, Plus, Pencil } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { EmptyState } from '@/client/components/common/EmptyState'
import { ActiveKinsIndicator } from '@/client/components/project/ActiveKinsIndicator'
import { cn } from '@/client/lib/utils'
import type { ProjectSummary } from '@/shared/types'

interface ProjectsSidebarProps {
  projects: ProjectSummary[]
  selectedId: string | null
  onSelect: (projectId: string) => void
  onCreate: () => void
  onEdit: (projectId: string) => void
}

export function ProjectsSidebar({ projects, selectedId, onSelect, onCreate, onEdit }: ProjectsSidebarProps) {
  const { t } = useTranslation()

  const sorted = [...projects].sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <aside className="surface-sidebar flex h-full w-64 shrink-0 flex-col border-r border-sidebar-border text-sidebar-foreground">
      <header className="flex items-center justify-between px-3 py-3">
        <h2 className="text-sm font-semibold">{t('projects.sidebar.title')}</h2>
        <Button size="icon" variant="ghost" onClick={onCreate} title={t('projects.sidebar.create')}>
          <Plus className="size-4" />
        </Button>
      </header>
      <div className="flex-1 overflow-y-auto p-2">
        {sorted.length === 0 && (
          <EmptyState
            compact
            icon={Kanban}
            title={t('projects.sidebar.emptyTitle')}
            description={t('projects.sidebar.emptyDescription')}
            actionLabel={t('projects.sidebar.create')}
            onAction={onCreate}
          />
        )}
        <ul className="space-y-1">
          {sorted.map((project) => {
            const active = project.id === selectedId
            return (
              <li key={project.id} className="group relative">
                {/* Left accent stripe — makes the selected project unmistakable
                    at a glance even when the background tint is subtle. */}
                {active && (
                  <span
                    aria-hidden
                    className="absolute inset-y-1.5 left-0 w-1 rounded-r-full bg-primary"
                  />
                )}
                {/* role="button" instead of a real <button> so the nested
                    Kin-avatar buttons in <ActiveKinsIndicator> are valid HTML.
                    HTML forbids button-in-button and React warns about it. */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(project.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onSelect(project.id)
                    }
                  }}
                  className={cn(
                    'flex w-full cursor-pointer flex-col gap-1 rounded-md px-3 py-2 pr-9 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'bg-primary/10 text-foreground'
                      : 'hover:bg-muted text-foreground/80 hover:text-foreground',
                  )}
                >
                  <span
                    className={cn(
                      'truncate text-sm',
                      active ? 'font-semibold' : 'font-medium',
                    )}
                  >
                    {project.title}
                  </span>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {project.slug && (
                        <span
                          className="truncate font-mono text-[11px] text-muted-foreground/80"
                          title={`Slug: ${project.slug}`}
                        >
                          {project.slug}
                        </span>
                      )}
                      <span>
                        {project.openTicketCount} / {project.ticketCount}
                      </span>
                    </div>
                    <ActiveKinsIndicator projectId={project.id} size="size-4" maxVisible={3} />
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => {
                    e.stopPropagation()
                    onEdit(project.id)
                  }}
                  className="absolute right-1.5 top-1/2 size-7 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                  title={t('projects.edit.openEdit')}
                >
                  <Pencil className="size-3.5" />
                </Button>
              </li>
            )
          })}
        </ul>
      </div>
    </aside>
  )
}
