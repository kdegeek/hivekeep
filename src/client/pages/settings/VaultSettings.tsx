import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/client/components/ui/button'
import { Plus, Lock, Settings2 } from 'lucide-react'
import { EmptyState } from '@/client/components/common/EmptyState'
import { HelpPanel } from '@/client/components/common/HelpPanel'
import { ListToolbar } from '@/client/components/common/ListToolbar'
import { SettingsListSkeleton } from '@/client/components/common/SettingsListSkeleton'
import { useListControls } from '@/client/hooks/useListControls'
import { LIST_FILTER_THRESHOLD } from '@/shared/constants'
import { api, getErrorMessage, toastError } from '@/client/lib/api'
import { useAgentList } from '@/client/hooks/useAgentList'
import { VaultSecretCard, type VaultSecretData } from '@/client/components/vault/VaultSecretCard'
import { VaultEntryFormDialog } from '@/client/components/vault/VaultEntryFormDialog'
import { VaultTypeManagerDialog } from '@/client/components/vault/VaultTypeManagerDialog'
import { VAULT_BUILTIN_TYPES } from '@/shared/constants'
import type { VaultTypeSummary } from '@/shared/types'

const ALL_TAB = 'all'
const FAVORITES_TAB = 'favorites'

export function VaultSettings() {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<VaultSecretData[]>([])
  const [customTypes, setCustomTypes] = useState<VaultTypeSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const { agentNames, agentAvatars } = useAgentList()
  const [modalOpen, setModalOpen] = useState(false)
  const [editingEntry, setEditingEntry] = useState<VaultSecretData | null>(null)
  const [activeTab, setActiveTab] = useState(ALL_TAB)
  const [typeManagerOpen, setTypeManagerOpen] = useState(false)

  useEffect(() => {
    fetchEntries()
    fetchCustomTypes()
  }, [])

  const fetchEntries = async () => {
    try {
      setFetchError(null)
      const data = await api.get<{ entries: VaultSecretData[] }>('/vault/entries')
      setEntries(data.entries)
    } catch (err: unknown) {
      setFetchError(getErrorMessage(err))
      toast.error(t('settings.vault.fetchError', 'Failed to load vault entries'))
    } finally {
      setIsLoading(false)
    }
  }

  const fetchCustomTypes = async () => {
    try {
      const data = await api.get<{ types: VaultTypeSummary[] }>('/vault/types')
      setCustomTypes(data.types)
    } catch (err: unknown) {
      toastError(err)
    }
  }

  const handleDeleteEntry = async (id: string) => {
    try {
      await api.delete(`/vault/entries/${id}`)
      await fetchEntries()
      toast.success(t('settings.vault.deleted'))
    } catch (err: unknown) {
      toastError(err)
    }
  }

  const handleToggleFavorite = async (entry: VaultSecretData) => {
    try {
      await api.patch(`/vault/entries/${entry.id}`, { isFavorite: !entry.isFavorite })
      setEntries((prev) =>
        prev.map((e) => (e.id === entry.id ? { ...e, isFavorite: !e.isFavorite } : e)),
      )
    } catch (err: unknown) {
      toastError(err)
    }
  }

  const handleSaved = async () => {
    await fetchEntries()
    toast.success(editingEntry ? t('settings.vault.saved') : t('settings.vault.added'))
  }

  const openAdd = () => {
    setEditingEntry(null)
    setModalOpen(true)
  }

  const openEdit = (entry: VaultSecretData) => {
    setEditingEntry(entry)
    setModalOpen(true)
  }

  // Build tab list: All, Favorites, built-in types, custom types
  const tabs = useMemo(() => {
    const list = [
      { id: ALL_TAB, label: t('settings.vault.tabAll') },
      { id: FAVORITES_TAB, label: t('settings.vault.tabFavorites') },
      ...VAULT_BUILTIN_TYPES.map((type) => ({
        id: type,
        label: t(`vault.types.${type}`, type),
      })),
      ...customTypes.map((ct) => ({
        id: ct.slug,
        label: ct.name,
      })),
    ]
    return list
  }, [t, customTypes])

  // Active-tab predicate + cross-tab text search (key / description). The
  // search box only shows once there are enough secrets to warrant it.
  const list = useListControls(entries, {
    filter: (e) => {
      if (activeTab === ALL_TAB) return true
      if (activeTab === FAVORITES_TAB) return !!e.isFavorite
      return (e.entryType ?? 'text') === activeTab
    },
    searchText: (e) => [e.key, e.description],
  })
  const filteredEntries = list.filtered
  const showSearch = entries.length >= LIST_FILTER_THRESHOLD

  if (isLoading) {
    return <SettingsListSkeleton count={2} />
  }

  if (fetchError) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive">{fetchError}</p>
        <Button variant="outline" onClick={() => {
          setIsLoading(true)
          setFetchError(null)
          fetchEntries()
        }}>
          {t('common.retry', 'Retry')}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t('settings.vault.description')}
        </p>
        <Button variant="ghost" size="icon-xs" onClick={() => setTypeManagerOpen(true)} title={t('settings.vault.manageTypes')}>
          <Settings2 className="size-4" />
        </Button>
      </div>

      <HelpPanel
        contentKey="settings.vault.help.content"
        bulletKeys={[
          'settings.vault.help.bullet1',
          'settings.vault.help.bullet2',
          'settings.vault.help.bullet3',
          'settings.vault.help.bullet4',
        ]}
        storageKey="help.vault.open"
      />

      {showSearch && (
        <ListToolbar
          query={list.query}
          onQueryChange={list.setQuery}
          placeholder={t('settings.vault.search', 'Search secrets...')}
          onClear={() => list.setQuery('')}
          active={list.isSearching}
        />
      )}

      {/* Type filter tabs */}
      <div className="flex flex-wrap gap-1.5">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              activeTab === tab.id
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {filteredEntries.length === 0 && (
        list.isSearching ? (
          <EmptyState minimal title={t('common.noResults', 'No results found')} />
        ) : (
          <EmptyState
            icon={Lock}
            title={activeTab === ALL_TAB ? t('settings.vault.empty') : t('settings.vault.emptyFiltered')}
            description={activeTab === ALL_TAB ? t('settings.vault.emptyDescription') : undefined}
            actionLabel={t('settings.vault.add')}
            onAction={openAdd}
          />
        )
      )}

      {filteredEntries.map((entry) => (
        <VaultSecretCard
          key={entry.id}
          secret={entry}
          agentName={entry.createdByAgentId ? agentNames.get(entry.createdByAgentId) : undefined}
          agentAvatarUrl={entry.createdByAgentId ? agentAvatars.get(entry.createdByAgentId) : undefined}
          onEdit={() => openEdit(entry)}
          onDelete={() => handleDeleteEntry(entry.id)}
          onToggleFavorite={() => handleToggleFavorite(entry)}
        />
      ))}

      <Button variant="outline" onClick={openAdd} className="w-full">
        <Plus className="size-4" />
        {t('settings.vault.add')}
      </Button>

      <VaultEntryFormDialog
        open={modalOpen}
        onOpenChange={setModalOpen}
        onSaved={handleSaved}
        entry={editingEntry}
        customTypes={customTypes}
      />

      <VaultTypeManagerDialog
        open={typeManagerOpen}
        onOpenChange={setTypeManagerOpen}
        customTypes={customTypes}
        onTypesChanged={fetchCustomTypes}
      />

    </div>
  )
}
