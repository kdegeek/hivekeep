import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/client/components/ui/button'
import { Badge } from '@/client/components/ui/badge'
import { Plus, Wrench, Lock, Pencil, Asterisk } from 'lucide-react'
import { EmptyState } from '@/client/components/common/EmptyState'
import { HelpPanel } from '@/client/components/common/HelpPanel'
import { ListToolbar } from '@/client/components/common/ListToolbar'
import { SettingsListSkeleton } from '@/client/components/common/SettingsListSkeleton'
import { ConfirmDeleteButton } from '@/client/components/common/ConfirmDeleteButton'
import { ToolboxFormDialog } from '@/client/components/toolbox/ToolboxFormDialog'
import { useListControls } from '@/client/hooks/useListControls'
import { LIST_FILTER_THRESHOLD } from '@/shared/constants'
import { useToolboxes } from '@/client/hooks/useToolboxes'
import { getErrorMessage, toastError } from '@/client/lib/api'
import type { Toolbox } from '@/shared/types'

export function ToolboxesSettings() {
  const { t } = useTranslation()
  const { toolboxes, isLoading, createToolbox, updateToolbox, deleteToolbox } = useToolboxes()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Toolbox | null>(null)

  function openCreate() {
    setEditing(null)
    setModalOpen(true)
  }

  function openEdit(toolbox: Toolbox) {
    setEditing(toolbox)
    setModalOpen(true)
  }

  async function handleDelete(id: string) {
    try {
      await deleteToolbox(id)
      toast.success(t('toolboxes.deleted'))
    } catch (err) {
      toastError(err)
    }
  }

  // Search (name/description); built-ins first, then alphabetical.
  const list = useListControls(toolboxes, {
    searchText: (tb) => [tb.name, tb.description],
    sort: (a, b) => (a.builtin !== b.builtin ? (a.builtin ? -1 : 1) : a.name.localeCompare(b.name)),
  })

  if (isLoading) {
    return <SettingsListSkeleton count={3} />
  }

  const sorted = list.filtered

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('toolboxes.description')}</p>

      <HelpPanel
        contentKey="toolboxes.help.content"
        bulletKeys={[
          'toolboxes.help.bullet1',
          'toolboxes.help.bullet2',
          'toolboxes.help.bullet3',
          'toolboxes.help.bullet4',
        ]}
        storageKey="help.toolboxes.open"
      />

      {toolboxes.length === 0 && (
        <EmptyState
          icon={Wrench}
          title={t('toolboxes.empty')}
          description={t('toolboxes.emptyDescription')}
          actionLabel={t('toolboxes.add')}
          onAction={openCreate}
        />
      )}

      {toolboxes.length >= LIST_FILTER_THRESHOLD && (
        <ListToolbar
          query={list.query}
          onQueryChange={list.setQuery}
          placeholder={t('toolboxes.search', 'Search toolboxes...')}
          onClear={() => list.setQuery('')}
          active={list.isSearching}
        />
      )}

      {toolboxes.length > 0 && sorted.length === 0 && (
        <EmptyState minimal title={t('common.noResults', 'No results found')} />
      )}

      {sorted.map((toolbox) => {
        const isWildcard = toolbox.toolNames.includes('*')
        return (
          <div
            key={toolbox.id}
            className="flex items-start justify-between gap-3 rounded-lg border bg-card/50 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10">
                  <Wrench className="size-3.5 text-primary" />
                </span>
                <span className="text-sm font-medium text-foreground">
                  {toolbox.builtin ? t(`toolboxes.builtin.${toolbox.name}`, toolbox.name) : toolbox.name}
                </span>
                {toolbox.builtin && (
                  <Badge variant="secondary" size="xs" className="gap-1">
                    <Lock className="size-3" />
                    {t('toolboxes.builtinBadge')}
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  {isWildcard ? (
                    <span className="flex items-center gap-0.5">
                      <Asterisk className="size-3" />
                      {t('toolboxes.allTools')}
                    </span>
                  ) : (
                    t('toolboxes.toolCount', { count: toolbox.toolNames.length })
                  )}
                </span>
              </div>
              {toolbox.description && (
                <p className="mt-1 pl-9 text-xs text-muted-foreground">{toolbox.description}</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={toolbox.builtin ? t('toolboxes.view') : t('common.edit')}
                onClick={() => openEdit(toolbox)}
              >
                <Pencil className="size-3.5" />
              </Button>
              {!toolbox.builtin && (
                <ConfirmDeleteButton
                  title={t('toolboxes.deleteTitle')}
                  description={t('toolboxes.deleteConfirm', { name: toolbox.name })}
                  onConfirm={() => handleDelete(toolbox.id)}
                />
              )}
            </div>
          </div>
        )
      })}

      <Button variant="outline" onClick={openCreate} className="w-full">
        <Plus className="size-4" />
        {t('toolboxes.add')}
      </Button>

      <ToolboxFormDialog
        open={modalOpen}
        onOpenChange={setModalOpen}
        toolbox={editing}
        onCreate={async (input) => {
          try {
            await createToolbox(input)
          } catch (err) {
            // Re-throw so the dialog can surface the message and stay open.
            throw new Error(getErrorMessage(err))
          }
        }}
        onUpdate={async (id, input) => {
          try {
            await updateToolbox(id, input)
          } catch (err) {
            throw new Error(getErrorMessage(err))
          }
        }}
      />
    </div>
  )
}
