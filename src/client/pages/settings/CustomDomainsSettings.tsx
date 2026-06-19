import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/client/components/ui/button'
import { Badge } from '@/client/components/ui/badge'
import { Plus, Shapes, Lock, Pencil } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import { EmptyState } from '@/client/components/common/EmptyState'
import { ListToolbar } from '@/client/components/common/ListToolbar'
import { SettingsListSkeleton } from '@/client/components/common/SettingsListSkeleton'
import { ConfirmDeleteButton } from '@/client/components/common/ConfirmDeleteButton'
import { DomainFormDialog } from '@/client/components/toolbox/DomainFormDialog'
import { useListControls } from '@/client/hooks/useListControls'
import { LIST_FILTER_THRESHOLD } from '@/shared/constants'
import { ToolDomainIcon } from '@/client/components/common/ToolDomainIcon'
import { useToolDomains } from '@/client/hooks/useToolDomains'
import { getErrorMessage, toastError } from '@/client/lib/api'
import { CURATED_DOMAIN_COLORS, TOOL_DOMAIN_META } from '@/shared/constants'
import type { ToolDomainEntry, BuiltinToolDomain } from '@/shared/types'

function colorClasses(d: ToolDomainEntry): { bg: string; text: string } {
  if (d.builtin) {
    const m = TOOL_DOMAIN_META[d.slug as BuiltinToolDomain]
    if (m) return { bg: m.bg, text: m.text }
  }
  const c = d.color ? CURATED_DOMAIN_COLORS[d.color as keyof typeof CURATED_DOMAIN_COLORS] : undefined
  return { bg: c?.bg ?? 'bg-muted', text: c?.text ?? 'text-muted-foreground' }
}

export function CustomDomainsSettings() {
  const { t } = useTranslation()
  const { domains, isLoading, createDomain, updateDomain, deleteDomain } = useToolDomains()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<ToolDomainEntry | null>(null)

  function openCreate() {
    setEditing(null)
    setModalOpen(true)
  }
  function openEdit(d: ToolDomainEntry) {
    setEditing(d)
    setModalOpen(true)
  }
  async function handleDelete(slug: string) {
    try {
      await deleteDomain(slug)
      toast.success(t('toolDomains.deleted'))
    } catch (err) {
      toastError(err)
    }
  }

  const list = useListControls(domains, {
    searchText: (d) => [d.label, d.slug, d.description],
    sort: (a, b) => (a.builtin !== b.builtin ? (a.builtin ? -1 : 1) : a.slug.localeCompare(b.slug)),
  })

  if (isLoading) return <SettingsListSkeleton count={4} />

  const sorted = list.filtered

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('toolDomains.description')}</p>

      {domains.length === 0 && (
        <EmptyState
          icon={Shapes}
          title={t('toolDomains.empty')}
          description={t('toolDomains.emptyDescription')}
          actionLabel={t('toolDomains.create')}
          onAction={openCreate}
        />
      )}

      {domains.length >= LIST_FILTER_THRESHOLD && (
        <ListToolbar
          query={list.query}
          onQueryChange={list.setQuery}
          placeholder={t('toolDomains.search', 'Search domains...')}
          onClear={() => list.setQuery('')}
          active={list.isSearching}
        />
      )}

      {domains.length > 0 && sorted.length === 0 && (
        <EmptyState minimal title={t('common.noResults', 'No results found')} />
      )}

      {sorted.map((d) => {
        const c = colorClasses(d)
        const label = d.builtin && d.labelKey ? t(d.labelKey) : (d.label ?? d.slug)
        return (
          <div key={d.slug} className="flex items-start justify-between gap-3 rounded-lg border bg-card/50 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-md', c.bg)}>
                  <ToolDomainIcon domain={d.slug} className={cn('size-3.5', c.text)} />
                </span>
                <span className="text-sm font-medium text-foreground">{label}</span>
                <code className="text-xs text-muted-foreground">{d.slug}</code>
                {d.builtin && (
                  <Badge variant="secondary" size="xs" className="gap-1">
                    <Lock className="size-3" />
                    {t('toolDomains.builtinBadge')}
                  </Badge>
                )}
              </div>
              {d.description && <p className="mt-1 pl-9 text-xs text-muted-foreground">{d.description}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="ghost" size="icon-xs" aria-label={d.builtin ? t('toolDomains.view') : t('common.edit')} onClick={() => openEdit(d)}>
                <Pencil className="size-3.5" />
              </Button>
              {!d.builtin && (
                <ConfirmDeleteButton
                  title={t('toolDomains.deleteTitle')}
                  description={t('toolDomains.deleteConfirm', { name: d.label ?? d.slug })}
                  onConfirm={() => handleDelete(d.slug)}
                />
              )}
            </div>
          </div>
        )
      })}

      <Button variant="outline" onClick={openCreate} className="w-full">
        <Plus className="size-4" />
        {t('toolDomains.create')}
      </Button>

      <DomainFormDialog
        open={modalOpen}
        onOpenChange={setModalOpen}
        domain={editing}
        onCreate={async (input) => {
          try {
            await createDomain(input)
          } catch (err) {
            throw new Error(getErrorMessage(err))
          }
        }}
        onUpdate={async (slug, input) => {
          try {
            await updateDomain(slug, input)
          } catch (err) {
            throw new Error(getErrorMessage(err))
          }
        }}
      />
    </div>
  )
}
