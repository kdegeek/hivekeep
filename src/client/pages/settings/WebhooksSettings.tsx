import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useCopyToClipboard } from '@/client/hooks/useCopyToClipboard'
import { Button } from '@/client/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/client/components/ui/alert-dialog'
import { FormDialog } from '@/client/components/common/FormDialog'
import { FormField } from '@/client/components/common/FormField'
import { Input } from '@/client/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/client/components/ui/select'
import { Plus, Copy, Eye, EyeOff, Webhook } from 'lucide-react'
import { EmptyState } from '@/client/components/common/EmptyState'
import { HelpPanel } from '@/client/components/common/HelpPanel'
import { ListToolbar } from '@/client/components/common/ListToolbar'
import { ListPagination } from '@/client/components/common/ListPagination'
import { SettingsListSkeleton } from '@/client/components/common/SettingsListSkeleton'
import { useListControls } from '@/client/hooks/useListControls'
import { LIST_FILTER_THRESHOLD } from '@/shared/constants'
import { api, toastError } from '@/client/lib/api'
import { useSSE } from '@/client/hooks/useSSE'
import { useAgentList } from '@/client/hooks/useAgentList'
import { WebhookCard } from '@/client/components/webhook/WebhookCard'
import { WebhookFormDialog } from '@/client/components/webhook/WebhookFormDialog'
import { WebhookLogDialog } from '@/client/components/webhook/WebhookLogDialog'
import type { WebhookSummary, WebhookFilterMode, WebhookDispatchMode } from '@/shared/types'
import type { AgentOption } from '@/client/components/common/AgentSelectItem'

interface WebhookWithToken extends WebhookSummary {
  token: string
}

export function WebhooksSettings() {
  const { t } = useTranslation()
  const [webhooks, setWebhooks] = useState<WebhookSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const { agents: agentList } = useAgentList()
  const agents: AgentOption[] = agentList.map((k) => ({ id: k.id, name: k.name, role: k.role ?? '', avatarUrl: k.avatarUrl }))
  const [modalOpen, setModalOpen] = useState(false)
  const [editingWebhook, setEditingWebhook] = useState<WebhookSummary | null>(null)
  const [regeneratingWebhook, setRegeneratingWebhook] = useState<WebhookSummary | null>(null)
  const [logsWebhook, setLogsWebhook] = useState<WebhookSummary | null>(null)

  // Token reveal state (after create or regenerate)
  const [revealedToken, setRevealedToken] = useState<{ url: string; token: string; name: string } | null>(null)
  const [showToken, setShowToken] = useState(false)
  const [filterAgentId, setFilterAgentId] = useState<string>('')

  // Search (name / description / Agent) + per-Agent filter + pagination.
  const list = useListControls(webhooks, {
    searchText: (w) => [w.name, w.description, w.agentName],
    filter: (w) => !filterAgentId || w.agentId === filterAgentId,
    pageSize: 20,
  })
  const showToolbar = webhooks.length >= LIST_FILTER_THRESHOLD
  const filtersActive = list.isSearching || !!filterAgentId
  const clearFilters = () => { list.setQuery(''); setFilterAgentId('') }

  const fetchWebhooks = useCallback(async () => {
    try {
      const data = await api.get<{ webhooks: WebhookSummary[] }>('/webhooks')
      setWebhooks(data.webhooks)
    } catch (err) {
      toast.error(t('webhooks.fetchError', 'Failed to load webhooks'))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchWebhooks()
  }, [fetchWebhooks])

  // Re-fetch webhooks list when SSE notifies of changes
  useSSE({
    'webhook:created': () => fetchWebhooks(),
    'webhook:updated': () => fetchWebhooks(),
    'webhook:deleted': (data) => {
      const webhookId = data.webhookId as string
      setWebhooks((prev) => prev.filter((w) => w.id !== webhookId))
    },
    'webhook:triggered': () => fetchWebhooks(),
  })

  const handleCreate = async (agentId: string, data: {
    name: string
    description?: string
    dispatchMode?: WebhookDispatchMode
    taskTitleTemplate?: string | null
    taskPromptTemplate?: string | null
    maxConcurrentTasks?: number
  }) => {
    const result = await api.post<{ webhook: WebhookWithToken }>('/webhooks', {
      agentId,
      name: data.name,
      description: data.description,
      dispatchMode: data.dispatchMode,
      taskTitleTemplate: data.taskTitleTemplate,
      taskPromptTemplate: data.taskPromptTemplate,
      maxConcurrentTasks: data.maxConcurrentTasks,
    })
    await fetchWebhooks()
    // Show token reveal dialog
    setRevealedToken({
      url: result.webhook.url,
      token: result.webhook.token,
      name: result.webhook.name,
    })
    setShowToken(false)
  }

  const handleUpdate = async (webhookId: string, data: {
    name?: string
    description?: string | null
    isActive?: boolean
    filterMode?: WebhookFilterMode | null
    filterField?: string | null
    filterAllowedValues?: string[] | null
    filterExpression?: string | null
    dispatchMode?: WebhookDispatchMode
    taskTitleTemplate?: string | null
    taskPromptTemplate?: string | null
    maxConcurrentTasks?: number
  }) => {
    await api.patch(`/webhooks/${webhookId}`, data)
    await fetchWebhooks()
    toast.success(t('settings.webhooks.saved'))
  }

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/webhooks/${id}`)
      await fetchWebhooks()
      toast.success(t('settings.webhooks.deleted'))
    } catch (err: unknown) {
      toastError(err)
    }
  }

  const handleRegenerateToken = async () => {
    if (!regeneratingWebhook) return
    try {
      const result = await api.post<{ token: string }>(`/webhooks/${regeneratingWebhook.id}/regenerate-token`)
      await fetchWebhooks()
      // Show token reveal dialog
      setRevealedToken({
        url: regeneratingWebhook.url,
        token: result.token,
        name: regeneratingWebhook.name,
      })
      setShowToken(false)
      toast.success(t('settings.webhooks.regenerated'))
    } catch (err: unknown) {
      toastError(err)
    } finally {
      setRegeneratingWebhook(null)
    }
  }

  const openAdd = () => {
    setEditingWebhook(null)
    setModalOpen(true)
  }

  const openEdit = (webhook: WebhookSummary) => {
    setEditingWebhook(webhook)
    setModalOpen(true)
  }

  const { copy } = useCopyToClipboard()

  if (isLoading) {
    return <SettingsListSkeleton count={2} />
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t('settings.webhooks.description')}
        </p>
      </div>

      <HelpPanel
        contentKey="settings.webhooks.help.content"
        bulletKeys={[
          'settings.webhooks.help.bullet1',
          'settings.webhooks.help.bullet2',
          'settings.webhooks.help.bullet3',
          'settings.webhooks.help.bullet4',
        ]}
        storageKey="help.webhooks.open"
      />

      {showToolbar && (
        <ListToolbar
          query={list.query}
          onQueryChange={list.setQuery}
          placeholder={t('settings.webhooks.search', 'Search webhooks...')}
          onClear={clearFilters}
          active={filtersActive}
        >
          {agents.length > 1 && (
            <Select value={filterAgentId || '__all__'} onValueChange={(v) => setFilterAgentId(v === '__all__' ? '' : v)}>
              <SelectTrigger className="w-full sm:w-auto sm:min-w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">{t('settings.webhooks.allAgents', 'All Agents')}</SelectItem>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </ListToolbar>
      )}

      {webhooks.length === 0 && (
        <EmptyState
          icon={Webhook}
          title={t('settings.webhooks.empty')}
          description={t('settings.webhooks.emptyDescription')}
          actionLabel={t('settings.webhooks.add')}
          onAction={openAdd}
        />
      )}

      {webhooks.length > 0 && list.total === 0 && (
        <EmptyState minimal title={t('common.noResults', 'No results found')} />
      )}

      {list.paged.map((webhook) => (
        <WebhookCard
          key={webhook.id}
          webhook={webhook}
          onEdit={() => openEdit(webhook)}
          onDelete={() => handleDelete(webhook.id)}
          onToggle={(isActive) => handleUpdate(webhook.id, { isActive })}
          onRegenerateToken={() => setRegeneratingWebhook(webhook)}
          onViewLogs={() => setLogsWebhook(webhook)}
        />
      ))}

      <ListPagination
        page={list.page}
        pageCount={list.pageCount}
        total={list.total}
        rangeFrom={list.rangeFrom}
        rangeTo={list.rangeTo}
        onPageChange={list.setPage}
        perPage={list.perPage}
        onPerPageChange={list.setPerPage}
      />

      <Button variant="outline" onClick={openAdd} className="w-full">
        <Plus className="size-4" />
        {t('settings.webhooks.add')}
      </Button>

      {/* Create/Edit form dialog */}
      <WebhookFormDialog
        open={modalOpen}
        onOpenChange={setModalOpen}
        onSave={handleCreate}
        onUpdate={handleUpdate}
        webhook={editingWebhook}
        agents={agents}
      />

      {/* Regenerate token confirmation */}
      <AlertDialog open={!!regeneratingWebhook} onOpenChange={(v) => { if (!v) setRegeneratingWebhook(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.webhooks.regenerateToken')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.webhooks.regenerateConfirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleRegenerateToken}>
              {t('settings.webhooks.regenerateToken')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Trigger logs dialog */}
      <WebhookLogDialog
        open={!!logsWebhook}
        onOpenChange={(v) => { if (!v) setLogsWebhook(null) }}
        webhook={logsWebhook}
      />

      {/* Token reveal dialog (shown after create or regenerate) */}
      <FormDialog
        open={!!revealedToken}
        onOpenChange={(v) => { if (!v) setRevealedToken(null) }}
        title={t('settings.webhooks.added')}
        description={
          <span className="text-warning">{t('settings.webhooks.tokenWarning')}</span>
        }
        size="lg"
        cancelLabel={t('common.close')}
      >
        {revealedToken && (
          <>
            <FormField label={t('common.url')}>
              <div className="flex gap-2">
                <Input value={revealedToken.url} readOnly className="font-mono text-xs" />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  onClick={() => copy(revealedToken.url, { successKey: 'settings.webhooks.urlCopied' })}
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            </FormField>
            <FormField label={t('settings.webhooks.tokenLabel')}>
              <div className="flex gap-2">
                <Input
                  value={showToken ? revealedToken.token : '•'.repeat(32)}
                  readOnly
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  onClick={() => setShowToken(!showToken)}
                >
                  {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  onClick={() => copy(revealedToken.token, { successKey: 'settings.webhooks.tokenCopied' })}
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            </FormField>
          </>
        )}
      </FormDialog>
    </div>
  )
}
