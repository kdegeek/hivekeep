import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import { Badge } from '@/client/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/client/components/ui/dialog'
import { EmptyState } from '@/client/components/common/EmptyState'
import { SettingsListSkeleton } from '@/client/components/common/SettingsListSkeleton'
import { api, toastError } from '@/client/lib/api'
import {
  Search,
  Download,
  Loader2,
  Check,
  RefreshCw,
  User,
  Trash2,
  ExternalLink,
  Package,
} from 'lucide-react'
import type { NpmPlugin } from '@/shared/types/plugin'

export function PluginMarketplace() {
  const { t } = useTranslation()

  const [results, setResults] = useState<Array<NpmPlugin & { installed: boolean }>>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [installingPlugin, setInstallingPlugin] = useState<string | null>(null)
  const [uninstallTarget, setUninstallTarget] = useState<string | null>(null)
  const [uninstalling, setUninstalling] = useState(false)

  // Debounced npm search: refetch 300ms after the user stops typing.
  useEffect(() => {
    const handle = setTimeout(() => {
      load(searchQuery)
    }, 300)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery])

  const load = async (q: string) => {
    setLoading(true)
    try {
      const url = q
        ? `/plugins/registry/npm-search?q=${encodeURIComponent(q)}`
        : '/plugins/registry/npm-search'
      const res = await api.get<{ plugins: Array<NpmPlugin & { installed: boolean }> }>(url)
      setResults(res?.plugins ?? [])
    } catch {
      setResults([])
    } finally {
      setLoading(false)
    }
  }

  // Aggregate user-facing tags from package keywords (skip the discovery keyword)
  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const p of results) {
      for (const k of p.keywords) {
        if (k !== 'kinbot-plugin' && k !== 'kinbot') set.add(k)
      }
    }
    return Array.from(set).sort()
  }, [results])

  const filteredResults = useMemo(() => {
    if (!selectedTag) return results
    return results.filter((p) => p.keywords.includes(selectedTag))
  }, [results, selectedTag])

  const handleInstall = async (plugin: NpmPlugin) => {
    setInstallingPlugin(plugin.name)
    try {
      const result = await api.post<{ success: boolean; name: string }>('/plugins/install', {
        source: 'npm',
        package: plugin.name,
      })
      toast.success(t('settings.marketplace.installSuccess', { name: result.name }))
      await load(searchQuery)
    } catch (err) {
      toastError(err)
    } finally {
      setInstallingPlugin(null)
    }
  }

  const confirmUninstall = async () => {
    if (!uninstallTarget) return
    setUninstalling(true)
    try {
      await api.delete(`/plugins/${uninstallTarget}`)
      toast.success(t('settings.marketplace.uninstallSuccess'))
      await load(searchQuery)
    } catch (err) {
      toastError(err)
    } finally {
      setUninstalling(false)
      setUninstallTarget(null)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">{t('settings.marketplace.title')}</h3>
          <p className="text-sm text-muted-foreground">{t('settings.marketplace.description')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => load(searchQuery)}>
          <RefreshCw className="size-4 mr-2" />
          {t('settings.marketplace.refresh')}
        </Button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <Input
          placeholder={t('settings.marketplace.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Tag filter (derived from npm result keywords) */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <Badge
            variant={selectedTag === null ? 'default' : 'outline'}
            className="cursor-pointer text-xs"
            onClick={() => setSelectedTag(null)}
          >
            {t('settings.marketplace.allTags')}
          </Badge>
          {allTags.map((tag) => (
            <Badge
              key={tag}
              variant={selectedTag === tag ? 'default' : 'outline'}
              className="cursor-pointer text-xs"
              onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
            >
              {tag}
            </Badge>
          ))}
        </div>
      )}

      {/* Results */}
      {loading ? (
        <SettingsListSkeleton />
      ) : filteredResults.length === 0 ? (
        <EmptyState
          icon={Package}
          title={t('settings.marketplace.npmEmpty.title')}
          description={t('settings.marketplace.npmEmpty.description')}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredResults.map((plugin) => (
            <NpmPluginCard
              key={plugin.name}
              plugin={plugin}
              installing={installingPlugin === plugin.name}
              onInstall={() => handleInstall(plugin)}
              onUninstall={() => setUninstallTarget(plugin.name)}
              t={t}
            />
          ))}
        </div>
      )}

      {/* Uninstall confirmation dialog */}
      <Dialog open={!!uninstallTarget} onOpenChange={(open) => !open && setUninstallTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.plugins.uninstallTitle')}</DialogTitle>
            <DialogDescription>
              {t('settings.plugins.uninstallDescription', { name: uninstallTarget })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUninstallTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmUninstall} disabled={uninstalling}>
              {uninstalling ? (
                <Loader2 className="size-4 mr-2 animate-spin" />
              ) : (
                <Trash2 className="size-4 mr-2" />
              )}
              {t('settings.marketplace.uninstall')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function NpmPluginCard({
  plugin,
  installing,
  onInstall,
  onUninstall,
  t,
}: {
  plugin: NpmPlugin & { installed: boolean }
  installing: boolean
  onInstall: () => void
  onUninstall: () => void
  t: (key: string, opts?: any) => string
}) {
  return (
    <div className="flex flex-col rounded-lg border p-4 surface-card hover:border-primary/50 transition-colors">
      <div className="flex items-center gap-1.5 mb-1">
        {plugin.installed && (
          <Badge variant="default" className="gap-1">
            <Check className="size-3" />
            {t('settings.marketplace.installed')}
          </Badge>
        )}
        <Badge variant="outline" className="text-[10px] gap-1">
          <Package className="size-3" />
          npm
        </Badge>
      </div>

      <div className="min-w-0">
        <h4 className="font-medium truncate">{plugin.name}</h4>
        {plugin.author && (
          <p className="text-xs text-muted-foreground">
            <User className="size-3 inline mr-1" />
            {plugin.author}
            {plugin.publisherUsername && plugin.publisherUsername !== plugin.author && (
              <span className="opacity-60"> (@{plugin.publisherUsername})</span>
            )}
          </p>
        )}
      </div>

      <p className="text-sm text-muted-foreground mt-2 line-clamp-3">
        {plugin.description || <span className="italic opacity-60">{t('settings.marketplace.noDescription')}</span>}
      </p>

      <div className="flex items-center gap-2 mt-3 text-xs text-muted-foreground">
        <Badge variant="outline" className="text-xs">v{plugin.version}</Badge>
        {plugin.links?.repository && (
          <a
            href={plugin.links.repository}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-foreground"
          >
            <ExternalLink className="size-3" />
            {t('settings.marketplace.repository')}
          </a>
        )}
        {plugin.links?.npm && (
          <a
            href={plugin.links.npm}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-foreground"
          >
            <ExternalLink className="size-3" />
            npm
          </a>
        )}
      </div>

      {plugin.keywords.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {plugin.keywords
            .filter((k) => k !== 'kinbot-plugin' && k !== 'kinbot')
            .slice(0, 4)
            .map((tag) => (
              <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
            ))}
        </div>
      )}

      <div className="mt-auto pt-3">
        {plugin.installed ? (
          <Button
            variant="outline"
            size="sm"
            className="w-full text-destructive hover:text-destructive"
            onClick={onUninstall}
          >
            {t('settings.marketplace.uninstall')}
          </Button>
        ) : (
          <Button size="sm" className="w-full" onClick={onInstall} disabled={installing}>
            {installing ? (
              <><Loader2 className="size-4 mr-2 animate-spin" />{t('settings.marketplace.installing')}</>
            ) : (
              <><Download className="size-4 mr-2" />{t('settings.marketplace.installBtn')}</>
            )}
          </Button>
        )}
      </div>
    </div>
  )
}
