import { useTranslation } from 'react-i18next'
import { Kanban, Plus, Pencil } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
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
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-card">
      <header className="flex items-center justify-between px-3 py-3">
        <h2 className="text-sm font-semibold">{t('projects.sidebar.title')}</h2>
        <Button size="icon" variant="ghost" onClick={onCreate} title={t('projects.sidebar.create')}>
          <Plus className="size-4" />
        </Button>
      </header>
      <div className="flex-1 overflow-y-auto p-2">
        {sorted.length === 0 && (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            <Kanban className="mx-auto mb-2 size-8 opacity-50" strokeWidth={1.5} />
            {t('projects.sidebar.empty')}
          </div>
        )}
        <ul className="space-y-1">
          {sorted.map((project) => {
            const active = project.id === selectedId
            return (
              <li key={project.id} className="group relative">
                <button
                  type="button"
                  onClick={() => onSelect(project.id)}
                  className={cn(
                    'flex w-full flex-col rounded-md px-3 py-2 pr-9 text-left transition-colors',
                    active
                      ? 'bg-primary/10 text-foreground'
                      : 'hover:bg-muted text-foreground/80 hover:text-foreground',
                  )}
                >
                  <span className="truncate text-sm font-medium">{project.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {project.openTicketCount} / {project.ticketCount}
                  </span>
                </button>
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
