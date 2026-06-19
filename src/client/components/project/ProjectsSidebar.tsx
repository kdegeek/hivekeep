import { useTranslation } from 'react-i18next'
import { Kanban, Plus, Pencil, Search } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
} from '@/client/components/ui/sidebar'
import { EmptyState } from '@/client/components/common/EmptyState'
import { ActiveAgentsIndicator } from '@/client/components/project/ActiveAgentsIndicator'
import { useListControls } from '@/client/hooks/useListControls'
import { LIST_FILTER_THRESHOLD } from '@/shared/constants'
import { cn } from '@/client/lib/utils'
import type { ProjectSummary } from '@/shared/types'

interface ProjectsSidebarProps {
  projects: ProjectSummary[]
  selectedId: string | null
  onSelect: (projectId: string) => void
  onCreate: () => void
  onEdit: (projectId: string) => void
}

/**
 * Projects navigation rail.
 *
 * Built on the shared shadcn <Sidebar> primitive (same as the Agents sidebar) so
 * it inherits resize, collapse (Ctrl+B) and the mobile Sheet drawer for free —
 * the parent page just needs a <SidebarProvider>. The item rendering stays
 * bespoke (accent stripe + slug/ticket counts + active-Agent avatars + edit).
 */
export function ProjectsSidebar({ projects, selectedId, onSelect, onCreate, onEdit }: ProjectsSidebarProps) {
  const { t } = useTranslation()

  // Search by title/slug, newest first. The box only appears once the rail
  // holds enough projects to be worth filtering (LIST_FILTER_THRESHOLD).
  const list = useListControls(projects, {
    searchText: (p) => [p.title, p.slug],
    sort: (a, b) => b.updatedAt - a.updatedAt,
  })
  const sorted = list.filtered
  const showSearch = projects.length >= LIST_FILTER_THRESHOLD

  return (
    <Sidebar className="surface-sidebar">
      <SidebarHeader>
        <div className="flex items-center justify-between gap-2 px-1">
          <h2 className="text-sm font-semibold">{t('projects.sidebar.title')}</h2>
          <Button size="icon" variant="ghost" onClick={onCreate} title={t('projects.sidebar.create')}>
            <Plus className="size-4" />
          </Button>
        </div>
        {showSearch && (
          <div className="relative px-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={list.query}
              onChange={(e) => list.setQuery(e.target.value)}
              placeholder={t('projects.sidebar.search', 'Search projects...')}
              className="h-8 pl-8"
            />
          </div>
        )}
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="p-2">
          {projects.length === 0 && (
            <EmptyState
              compact
              icon={Kanban}
              title={t('projects.sidebar.emptyTitle')}
              description={t('projects.sidebar.emptyDescription')}
              actionLabel={t('projects.sidebar.create')}
              onAction={onCreate}
            />
          )}
          {projects.length > 0 && sorted.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              {t('common.noResults', 'No results found')}
            </p>
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
                      Agent-avatar buttons in <ActiveAgentsIndicator> are valid HTML.
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
                      <ActiveAgentsIndicator projectId={project.id} size="size-4" maxVisible={3} />
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
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}
