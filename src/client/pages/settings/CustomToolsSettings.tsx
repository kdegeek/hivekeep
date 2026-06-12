import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/client/components/ui/button'
import { Switch } from '@/client/components/ui/switch'
import { Plus, Wrench, Pencil, Code2 } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import { EmptyState } from '@/client/components/common/EmptyState'
import { HelpPanel } from '@/client/components/common/HelpPanel'
import { SettingsListSkeleton } from '@/client/components/common/SettingsListSkeleton'
import { ConfirmDeleteButton } from '@/client/components/common/ConfirmDeleteButton'
import { ToolDomainBadge } from '@/client/components/common/ToolDomainBadge'
import { CustomToolFormDialog } from '@/client/components/toolbox/CustomToolFormDialog'
import { useCustomTools } from '@/client/hooks/useCustomTools'
import { toastError } from '@/client/lib/api'
import type { CustomTool } from '@/shared/types'

export function CustomToolsSettings() {
  const { t, i18n } = useTranslation()
  // Resolve the active UI locale's display name override (falls back to base).
  const locale = i18n.language?.split('-')[0] ?? 'en'
  const {
    tools,
    isLoading,
    createTool,
    updateTool,
    deleteTool,
    readFile,
    writeFile,
    runSetup,
    testTool,
  } = useCustomTools()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<CustomTool | null>(null)

  function openCreate() {
    setEditing(null)
    setModalOpen(true)
  }
  function openEdit(tool: CustomTool) {
    setEditing(tool)
    setModalOpen(true)
  }
  async function handleDelete(slug: string) {
    try {
      await deleteTool(slug)
      toast.success(t('customTools.deleted'))
    } catch (err) {
      toastError(err)
    }
  }
  async function toggleEnabled(tool: CustomTool) {
    try {
      await updateTool(tool.slug, { enabled: !tool.enabled })
    } catch (err) {
      toastError(err)
    }
  }

  if (isLoading) return <SettingsListSkeleton count={3} />

  const sorted = [...tools].sort((a, b) => a.slug.localeCompare(b.slug))

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('customTools.description')}</p>

      <HelpPanel
        contentKey="customTools.help.content"
        bulletKeys={['customTools.help.bullet1', 'customTools.help.bullet2', 'customTools.help.bullet3']}
        storageKey="help.customTools.open"
      />

      {sorted.length === 0 && (
        <EmptyState
          icon={Code2}
          title={t('customTools.empty')}
          description={t('customTools.emptyDescription')}
          actionLabel={t('customTools.create')}
          onAction={openCreate}
        />
      )}

      {sorted.map((tool) => (
        <div key={tool.slug} className={cn('flex items-start justify-between gap-3 rounded-lg border bg-card/50 px-4 py-3', !tool.enabled && 'opacity-60')}>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10">
                <Wrench className="size-3.5 text-primary" />
              </span>
              <span className="text-sm font-medium text-foreground">{tool.translations?.[locale]?.name?.trim() || tool.name}</span>
              <code className="text-xs text-muted-foreground">custom_{tool.slug}</code>
              <ToolDomainBadge domain={tool.domainSlug} />
              {tool.createdBy === 'agent' && (
                <span className="text-[10px] text-muted-foreground">{t('customTools.byAgent')}</span>
              )}
            </div>
            {tool.description && <p className="mt-1 pl-9 text-xs text-muted-foreground">{tool.description}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Switch checked={tool.enabled} onCheckedChange={() => toggleEnabled(tool)} aria-label={t('customTools.enabled')} />
            <Button variant="ghost" size="icon-xs" aria-label={t('common.edit')} onClick={() => openEdit(tool)}>
              <Pencil className="size-3.5" />
            </Button>
            <ConfirmDeleteButton
              title={t('customTools.deleteTitle')}
              description={t('customTools.deleteConfirm', { name: tool.name })}
              onConfirm={() => handleDelete(tool.slug)}
            />
          </div>
        </div>
      ))}

      <Button variant="outline" onClick={openCreate} className="w-full">
        <Plus className="size-4" />
        {t('customTools.create')}
      </Button>

      <CustomToolFormDialog
        open={modalOpen}
        onOpenChange={setModalOpen}
        tool={editing}
        onCreate={createTool}
        onUpdate={updateTool}
        readFile={readFile}
        writeFile={writeFile}
        runSetup={runSetup}
        testTool={testTool}
      />
    </div>
  )
}
