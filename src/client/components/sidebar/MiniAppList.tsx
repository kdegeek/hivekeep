import { useState, useMemo, useCallback, memo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  SidebarGroupContent,
} from '@/client/components/ui/sidebar'
import { Input } from '@/client/components/ui/input'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/components/ui/avatar'
import { useMiniApps } from '@/client/hooks/useMiniApps'
import { useSidePanel } from '@/client/contexts/SidePanelContext'
import { cn } from '@/client/lib/utils'
import { AppWindow, LayoutGrid, List, Loader2, Search, Trash2 } from 'lucide-react'
import { EmptyState } from '@/client/components/common/EmptyState'
import { ConfirmDeleteButton } from '@/client/components/common/ConfirmDeleteButton'
import type { MiniAppSummary } from '@/shared/types'

function MiniAppIcon({ app, size = 'md' }: { app: MiniAppSummary; size?: 'sm' | 'md' | 'lg' }) {
  const sizeClass = size === 'lg' ? 'size-14 text-3xl rounded-xl' : size === 'md' ? 'size-10 text-xl rounded-lg' : 'size-8 text-lg rounded-md'
  if (app.iconUrl) {
    return <img src={app.iconUrl} alt={app.name} className={cn(sizeClass, 'object-cover shrink-0')} />
  }
  return (
    <div className={cn('flex shrink-0 items-center justify-center bg-secondary', sizeClass)}>
      {app.icon || '\u{1F4E6}'}
    </div>
  )
}

function MiniAppCard({
  app,
  isActive,
  badge,
  onClick,
  onDelete,
}: {
  app: MiniAppSummary
  isActive: boolean
  badge?: string | null
  onClick: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick() }}
      className={cn(
        'group flex items-center gap-2.5 rounded-lg bg-sidebar-accent/30 px-2.5 py-2 text-xs hover:bg-sidebar-accent/50 transition-colors cursor-pointer',
        isActive && 'ring-1 ring-primary/40 bg-sidebar-accent/50',
        !app.isActive && 'opacity-60',
      )}
    >
      <MiniAppIcon app={app} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate font-medium text-foreground">{app.name}</p>
          {app.hasBackend && (
            <span className="shrink-0 rounded bg-primary/15 px-1 py-0 text-[9px] font-medium text-primary leading-tight">
              API
            </span>
          )}
        </div>
        {app.description && (
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
            {app.description}
          </p>
        )}
        <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground/70">
          <Avatar className="size-3">
            {app.kinAvatarUrl && <AvatarImage src={app.kinAvatarUrl} alt={app.kinName} />}
            <AvatarFallback className="text-[6px]">{app.kinName.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="truncate">{app.kinName}</span>
          <span className="opacity-50">·</span>
          <span>v{app.version}</span>
        </div>
      </div>
      {badge && !isActive && (
        <span className="shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground">
          {badge}
        </span>
      )}
      {isActive && (
        <div className="size-1.5 shrink-0 rounded-full bg-primary" />
      )}
      <ConfirmDeleteButton
        onConfirm={onDelete}
        title={t('miniApps.deleteTitle')}
        description={t('miniApps.deleteConfirm', { name: app.name })}
        confirmLabel={t('miniApps.deleteAction')}
        trigger={
          <button
            type="button"
            className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
            title={t('miniApps.delete')}
          >
            <Trash2 className="size-3" />
          </button>
        }
      />
    </div>
  )
}

function MiniAppTile({
  app,
  isActive,
  badge,
  onClick,
  onDelete,
}: {
  app: MiniAppSummary
  isActive: boolean
  badge?: string | null
  onClick: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick() }}
      className={cn(
        'group relative flex flex-col items-center gap-1.5 rounded-lg bg-sidebar-accent/30 p-2.5 text-xs hover:bg-sidebar-accent/50 transition-colors cursor-pointer',
        isActive && 'ring-1 ring-primary/40 bg-sidebar-accent/50',
        !app.isActive && 'opacity-60',
      )}
    >
      {app.hasBackend && (
        <span className="absolute right-1.5 top-1.5 shrink-0 rounded bg-primary/15 px-1 py-0 text-[8px] font-medium text-primary leading-tight">
          API
        </span>
      )}
      <MiniAppIcon app={app} size="md" />
      <p className="w-full truncate text-center text-[11px] font-medium text-foreground">{app.name}</p>
      <div className="flex items-center gap-1 text-[9px] text-muted-foreground/70">
        <Avatar className="size-3">
          {app.kinAvatarUrl && <AvatarImage src={app.kinAvatarUrl} alt={app.kinName} />}
          <AvatarFallback className="text-[5px]">{app.kinName.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
        <span className="max-w-[4rem] truncate">{app.kinName}</span>
        <span className="opacity-50">·</span>
        <span>v{app.version}</span>
      </div>
      {badge && !isActive && (
        <span className="absolute -right-1 -top-1 rounded-full bg-primary px-1.5 py-0.5 text-[9px] font-semibold leading-none text-primary-foreground">
          {badge}
        </span>
      )}
      {isActive && !badge && (
        <div className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-primary" />
      )}
      <ConfirmDeleteButton
        onConfirm={onDelete}
        title={t('miniApps.deleteTitle')}
        description={t('miniApps.deleteConfirm', { name: app.name })}
        confirmLabel={t('miniApps.deleteAction')}
        trigger={
          <button
            type="button"
            className="absolute left-1 top-1 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
            title={t('miniApps.delete')}
          >
            <Trash2 className="size-3" />
          </button>
        }
      />
    </div>
  )
}

export const MiniAppList = memo(function MiniAppList() {
  const { t } = useTranslation()
  const { apps, isLoading, deleteApp } = useMiniApps(null, 'all')
  const { activeAppId, badges, openApp, closePanel } = useSidePanel()
  const [searchQuery, setSearchQuery] = useState('')
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() =>
    (localStorage.getItem('kinbot:sidebar-miniapps-view-mode') as 'grid' | 'list') || 'list',
  )

  const toggleView = (mode: 'grid' | 'list') => {
    setViewMode(mode)
    localStorage.setItem('kinbot:sidebar-miniapps-view-mode', mode)
  }

  const filteredApps = useMemo(() => {
    if (!searchQuery.trim()) return apps
    const q = searchQuery.toLowerCase()
    return apps.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.kinName.toLowerCase().includes(q) ||
        (a.description?.toLowerCase().includes(q)),
    )
  }, [apps, searchQuery])

  const handleDelete = useCallback(async (appId: string) => {
    if (appId === activeAppId) closePanel()
    await deleteApp(appId)
  }, [activeAppId, closePanel, deleteApp])

  const isEmpty = filteredApps.length === 0 && !isLoading

  return (
    <>
      {/* View toggle + Search — fixed above scroll */}
      <div className="shrink-0">
        <div className="flex items-center justify-end gap-0.5 px-1 pb-1">
          <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
            <button
              type="button"
              onClick={() => toggleView('grid')}
              className={cn(
                'rounded p-0.5 transition-colors',
                viewMode === 'grid' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
              title={t('sidebar.miniApps.viewGrid')}
            >
              <LayoutGrid className="size-3" />
            </button>
            <button
              type="button"
              onClick={() => toggleView('list')}
              className={cn(
                'rounded p-0.5 transition-colors',
                viewMode === 'list' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
              title={t('sidebar.miniApps.viewList')}
            >
              <List className="size-3" />
            </button>
          </div>
        </div>
        {apps.length > 0 && (
          <div className="px-1 pb-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('sidebar.miniApps.search')}
                className="h-8 pl-8 text-xs"
              />
            </div>
          </div>
        )}
      </div>

      <SidebarGroupContent className="flex-1 min-h-0 overflow-y-auto">
        {isLoading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : isEmpty ? (
          searchQuery ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              {t('sidebar.miniApps.noResults')}
            </p>
          ) : (
            <EmptyState
              compact
              icon={AppWindow}
              title={t('sidebar.miniApps.empty')}
              description={t('sidebar.miniApps.emptyDescription')}
            />
          )
        ) : viewMode === 'grid' ? (
          <div className="grid grid-cols-2 gap-1.5 px-1 pt-1 pb-1">
            {filteredApps.map((app) => (
              <MiniAppTile
                key={app.id}
                app={app}
                isActive={app.id === activeAppId}
                badge={badges[app.id]}
                onClick={() => openApp(app.id)}
                onDelete={() => handleDelete(app.id)}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-1 px-1 pt-1">
            {filteredApps.map((app) => (
              <MiniAppCard
                key={app.id}
                app={app}
                isActive={app.id === activeAppId}
                badge={badges[app.id]}
                onClick={() => openApp(app.id)}
                onDelete={() => handleDelete(app.id)}
              />
            ))}
          </div>
        )}
      </SidebarGroupContent>
    </>
  )
})
