import { useTranslation } from 'react-i18next'
import { Button } from '@/client/components/ui/button'
import { Plus, Cpu } from 'lucide-react'
import { EmptyState } from '@/client/components/common/EmptyState'
import { HelpPanel } from '@/client/components/common/HelpPanel'
import { ListToolbar } from '@/client/components/common/ListToolbar'
import { SettingsListSkeleton } from '@/client/components/common/SettingsListSkeleton'
import { TestAllProviders } from '@/client/components/common/TestAllProviders'
import { useListControls } from '@/client/hooks/useListControls'
import { LIST_FILTER_THRESHOLD } from '@/shared/constants'
import { ProviderCard } from '@/client/components/agent/ProviderCard'
import { ProviderFormDialog } from '@/client/components/agent/AddProviderDialog'
import { useProviders } from '@/client/hooks/useProviders'
import { useProviderActions } from '@/client/hooks/useProviderActions'
import { useProviderTypes } from '@/client/hooks/useProviderTypes'

export function ProvidersSettings() {
  const { t } = useTranslation()
  // Live catalogue (built-ins + plugin-contributed). Used both as the
  // filter for the saved providers list and as the picker entries.
  const catalogue = useProviderTypes()
  // Every provider family the host knows about. The Providers page is
  // capability-agnostic: LLM, embedding, image, search, TTS, STT —
  // same UX, same table, same lifecycle.
  const providerTypes = catalogue.entries.length > 0
    ? catalogue.entries
        .filter((e) => e.capabilities.some((c) => c === 'llm' || c === 'embedding' || c === 'image' || c === 'search' || c === 'tts' || c === 'stt'))
        .map((e) => e.type)
    : catalogue.types
  const { providers, isLoading, refetch: fetchProviders } = useProviders({ filterTypes: providerTypes })

  const {
    testingId,
    testAllState,
    editingProvider,
    modalOpen,
    setModalOpen,
    handleTestAll,
    handleTestProvider,
    handleDeleteProvider,
    handleProviderSaved,
    openAdd,
    openEdit,
  } = useProviderActions({ providers, refetch: fetchProviders })

  const list = useListControls(providers, {
    searchText: (p) => [p.name, p.type, p.slug],
  })

  if (isLoading) {
    return <SettingsListSkeleton count={3} />
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t('settings.providers.description')}
        </p>
      </div>

      <HelpPanel
        contentKey="settings.providers.help.content"
        bulletKeys={[
          'settings.providers.help.bullet1',
          'settings.providers.help.bullet2',
          'settings.providers.help.bullet3',
          'settings.providers.help.bullet4',
        ]}
        storageKey="help.providers.open"
      />

      {providers.length > 1 && (
        <TestAllProviders testAllState={testAllState} onTestAll={handleTestAll} />
      )}

      {providers.length === 0 && (
        <EmptyState
          icon={Cpu}
          title={t('settings.providers.empty')}
          description={t('settings.providers.emptyDescription')}
          actionLabel={t('settings.providers.add')}
          onAction={openAdd}
        />
      )}

      {providers.length >= LIST_FILTER_THRESHOLD && (
        <ListToolbar
          query={list.query}
          onQueryChange={list.setQuery}
          placeholder={t('settings.providers.search', 'Search providers...')}
          onClear={() => list.setQuery('')}
          active={list.isSearching}
        />
      )}

      {providers.length > 0 && list.total === 0 && (
        <EmptyState minimal title={t('common.noResults', 'No results found')} />
      )}

      {list.filtered.map((provider) => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          isTesting={testingId === provider.id}
          onTest={() => handleTestProvider(provider.id)}
          onEdit={() => openEdit(provider)}
          onDelete={() => handleDeleteProvider(provider.id)}
        />
      ))}

      <Button variant="outline" onClick={openAdd} className="w-full">
        <Plus className="size-4" />
        {t('settings.providers.add')}
      </Button>

      <ProviderFormDialog
        open={modalOpen}
        onOpenChange={setModalOpen}
        onSaved={handleProviderSaved}
        provider={editingProvider}
        providerTypes={providerTypes}
      />
    </div>
  )
}
