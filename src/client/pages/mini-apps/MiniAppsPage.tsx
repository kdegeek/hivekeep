import { useState, useMemo, useCallback, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { lazyWithRetry as lazy } from '@/client/lib/lazy-with-retry'
import { Input } from '@/client/components/ui/input'
import { useMiniApps } from '@/client/hooks/useMiniApps'
import { useSidePanel } from '@/client/contexts/SidePanelContext'
import { cn } from '@/client/lib/utils'
import { AppWindow, Blocks, LayoutGrid, List, Loader2, Search } from 'lucide-react'
import { EmptyState } from '@/client/components/common/EmptyState'
import { MiniAppCard, MiniAppTile } from '@/client/components/mini-app/MiniAppCard'

// Side panel viewer — opening an app renders it here (state lives in
// SidePanelProvider at the App root, surviving navigation).
const MiniAppViewer = lazy(() => import('@/client/components/mini-app/MiniAppViewer').then(m => ({ default: m.MiniAppViewer })))

const VIEW_MODE_KEY = 'kinbot:miniapps-page-view-mode'

export function MiniAppsPage() {
  const { t } = useTranslation()
  const { apps, isLoading, deleteApp } = useMiniApps(null, 'all')
  const { activeAppId, badges, openApp, closePanel } = useSidePanel()
  const [searchQuery, setSearchQuery] = useState('')
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() =>
    (localStorage.getItem(VIEW_MODE_KEY) as 'grid' | 'list') || 'grid',
  )

  const toggleView = (mode: 'grid' | 'list') => {
    setViewMode(mode)
    localStorage.setItem(VIEW_MODE_KEY, mode)
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
    <div className="surface-base flex h-full overflow-hidden">
      <main className="flex min-w-0 flex-1 flex-col">
        {/* Page header */}
        <header className="flex shrink-0 flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center">
          <div className="flex min-w-0 items-center gap-2.5">
            <Blocks className="size-5 shrink-0 text-primary" />
            <h1 className="truncate text-base font-semibold">{t('activityBar.apps')}</h1>
          </div>
          <div className="flex items-center gap-2 sm:ml-auto">
            {apps.length > 0 && (
              <div className="relative w-full sm:w-72">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('sidebar.miniApps.search')}
                  className="h-9 pl-8"
                />
              </div>
            )}
            <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5">
              <button
                type="button"
                onClick={() => toggleView('grid')}
                className={cn(
                  'rounded p-1.5 transition-colors',
                  viewMode === 'grid' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
                title={t('sidebar.miniApps.viewGrid')}
              >
                <LayoutGrid className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => toggleView('list')}
                className={cn(
                  'rounded p-1.5 transition-colors',
                  viewMode === 'list' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
                title={t('sidebar.miniApps.viewList')}
              >
                <List className="size-4" />
              </button>
            </div>
          </div>
        </header>

        {/* Body */}
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : isEmpty ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="w-full max-w-md">
              {searchQuery ? (
                <p className="text-center text-sm text-muted-foreground">{t('sidebar.miniApps.noResults')}</p>
              ) : (
                <EmptyState
                  icon={AppWindow}
                  title={t('sidebar.miniApps.empty')}
                  description={t('sidebar.miniApps.emptyDescription')}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="mx-auto max-w-6xl">
              {viewMode === 'grid' ? (
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
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
                <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
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
            </div>
          </div>
        )}
      </main>

      {/* Side panel (app viewer) */}
      <Suspense fallback={null}>
        <MiniAppViewer />
      </Suspense>
    </div>
  )
}
