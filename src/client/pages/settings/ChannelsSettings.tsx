import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/client/components/ui/button'
import { Switch } from '@/client/components/ui/switch'
import { Collapsible, CollapsibleContent } from '@/client/components/ui/collapsible'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/client/components/ui/select'
import { Plus, MessageCircle, AlertTriangle } from 'lucide-react'
import { EmptyState } from '@/client/components/common/EmptyState'
import { HelpPanel } from '@/client/components/common/HelpPanel'
import { ListToolbar } from '@/client/components/common/ListToolbar'
import { SettingsListSkeleton } from '@/client/components/common/SettingsListSkeleton'
import { useListControls } from '@/client/hooks/useListControls'
import { LIST_FILTER_THRESHOLD } from '@/shared/constants'
import { api, toastError } from '@/client/lib/api'
import { useSSE } from '@/client/hooks/useSSE'
import { useAgentList } from '@/client/hooks/useAgentList'
import { PlatformIcon } from '@/client/components/common/PlatformIcon'
import { ChannelCard } from '@/client/components/channel/ChannelCard'
import { ChannelFormDialog } from '@/client/components/channel/ChannelFormDialog'
import { ChannelRepairDialog } from '@/client/components/channel/ChannelRepairDialog'
import { ChannelUserMappings } from '@/client/components/channel/ChannelUserMappings'
import { ChannelWebhookField } from '@/client/components/channel/ChannelWebhookField'
import { usePlatforms } from '@/client/hooks/usePlatforms'
import type { ChannelSummary } from '@/shared/types'
import type { AgentOption } from '@/client/components/common/AgentSelectItem'

export function ChannelsSettings() {
  const { t } = useTranslation()
  const [channels, setChannels] = useState<ChannelSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const { agents: agentList } = useAgentList()
  const agents: AgentOption[] = agentList.map((k) => ({ id: k.id, name: k.name, role: k.role ?? '', avatarUrl: k.avatarUrl }))
  const [modalOpen, setModalOpen] = useState(false)
  const [editingChannel, setEditingChannel] = useState<ChannelSummary | null>(null)
  const [repairChannel, setRepairChannel] = useState<ChannelSummary | null>(null)
  // Platforms that pair by QR (generic — read off the platform's `pairing`
  // capability, never a hardcoded platform name).
  const { platforms } = usePlatforms()
  const qrPlatforms = new Set(platforms.filter((p) => p.pairing === 'qr').map((p) => p.platform))
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [platformFilter, setPlatformFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')

  // Search (name / platform / Agent) + platform & status filters. The bar only
  // appears once the list is long enough to warrant it (LIST_FILTER_THRESHOLD).
  const list = useListControls(channels, {
    searchText: (c) => [c.name, c.platform, c.agentName],
    filter: (c) =>
      (platformFilter === 'all' || c.platform === platformFilter) &&
      (statusFilter === 'all' || c.status === statusFilter),
  })
  const platformsPresent = useMemo(
    () => [...new Set(channels.map((c) => c.platform))],
    [channels],
  )
  const showToolbar = channels.length >= LIST_FILTER_THRESHOLD
  const filtersActive = list.isSearching || platformFilter !== 'all' || statusFilter !== 'all'
  const clearFilters = () => { list.setQuery(''); setPlatformFilter('all'); setStatusFilter('all') }

  const fetchChannels = useCallback(async () => {
    try {
      const data = await api.get<{ channels: ChannelSummary[] }>('/channels')
      setChannels(data.channels)
    } catch {
      // Ignore
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchChannels()
  }, [fetchChannels])

  // SSE: react to channel changes from other tabs/users
  useSSE({
    'channel:created': () => { fetchChannels() },
    'channel:updated': () => { fetchChannels() },
    'channel:deleted': (data) => {
      const channelId = data.channelId as string
      setChannels((prev) => prev.filter((c) => c.id !== channelId))
    },
    'channel:user-pending': () => { fetchChannels() },
    'channel:user-approved': () => { fetchChannels() },
    'channel:transferred': () => { fetchChannels() },
  })

  // Auto-expand channels with pending approval requests
  useEffect(() => {
    if (expandedId) return // don't override manual selection
    const pending = channels.find((c) => c.pendingApprovalCount > 0)
    if (pending) setExpandedId(pending.id)
  }, [channels]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = async (data: {
    agentId: string
    name: string
    platform: string
    platformConfig: Record<string, unknown>
  }) => {
    await api.post('/channels', data)
    await fetchChannels()
    toast.success(t('settings.channels.created'))
  }

  const handleUpdate = async (channelId: string, data: { name?: string }) => {
    await api.patch(`/channels/${channelId}`, data)
    await fetchChannels()
    toast.success(t('settings.channels.saved'))
  }

  // Toggle the per-channel approval requirement. The switch shows
  // "require approval" (= !autoCreateContacts); turning it off auto-creates
  // contacts and lets unknown senders through immediately (a security tradeoff
  // surfaced by the warning below).
  const handleToggleApproval = async (channel: ChannelSummary) => {
    try {
      await api.patch(`/channels/${channel.id}`, { autoCreateContacts: !channel.autoCreateContacts })
      await fetchChannels()
      toast.success(t('settings.channels.saved'))
    } catch (err: unknown) {
      toastError(err)
    }
  }

  const handleTransfer = async (
    channelId: string,
    data: { targetAgentId: string; reason?: string },
  ) => {
    const result = await api.post<{
      ok: boolean
      noop?: boolean
      toAgentName?: string
      newAgentSlug?: string
    }>(`/channels/${channelId}/transfer`, data)
    // SSE 'channel:transferred' will refetch the list independently, but
    // call fetchChannels() too for the rare case where the SSE is delayed
    // (e.g. tab in background). Both paths are idempotent.
    await fetchChannels()
    if (result.noop) {
      toast.info(t('settings.channels.transferNoop', 'Channel is already bound to this Agent.'))
    } else {
      toast.success(
        t('settings.channels.transferred', 'Channel transferred to {{agentName}}.', {
          agentName: result.toAgentName ?? result.newAgentSlug ?? '',
        }),
      )
    }
  }

  const handleDelete = async (channelId: string) => {
    try {
      await api.delete(`/channels/${channelId}`)
      await fetchChannels()
      toast.success(t('settings.channels.deleted'))
    } catch (err: unknown) {
      toastError(err)
    }
  }

  const handleToggle = async (channel: ChannelSummary) => {
    setTogglingId(channel.id)
    try {
      const action = channel.status === 'active' ? 'deactivate' : 'activate'
      await api.post(`/channels/${channel.id}/${action}`)
      await fetchChannels()
      toast.success(channel.status === 'active'
        ? t('settings.channels.deactivate')
        : t('settings.channels.activate'),
      )
    } catch (err: unknown) {
      toastError(err)
    } finally {
      setTogglingId(null)
    }
  }

  const handleTest = async (channel: ChannelSummary) => {
    setTestingId(channel.id)
    try {
      const result = await api.post<{ valid: boolean; error?: string; botInfo?: { name: string; username?: string } }>(`/channels/${channel.id}/test`)
      if (result.valid) {
        const info = result.botInfo ? ` (${result.botInfo.name}${result.botInfo.username ? ` @${result.botInfo.username}` : ''})` : ''
        toast.success(`${t('settings.channels.testSuccess')}${info}`)
      } else {
        toast.error(`${t('settings.channels.testFailed')}: ${result.error}`)
      }
    } catch (err: unknown) {
      toastError(err)
    } finally {
      setTestingId(null)
    }
  }

  const openAdd = () => {
    setEditingChannel(null)
    setModalOpen(true)
  }

  const openEdit = (channel: ChannelSummary) => {
    setEditingChannel(channel)
    setModalOpen(true)
  }

  if (isLoading) {
    return <SettingsListSkeleton count={2} />
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t('settings.channels.description')}
        </p>
      </div>

      <HelpPanel
        contentKey="settings.channels.help.content"
        bulletKeys={[
          'settings.channels.help.bullet1',
          'settings.channels.help.bullet2',
          'settings.channels.help.bullet3',
          'settings.channels.help.bullet4',
        ]}
        storageKey="help.channels.open"
      />

      {channels.length === 0 && (
        <EmptyState
          icon={MessageCircle}
          title={t('settings.channels.empty')}
          description={t('settings.channels.emptyDescription')}
          actionLabel={t('settings.channels.add')}
          onAction={openAdd}
        />
      )}

      {showToolbar && (
        <ListToolbar
          query={list.query}
          onQueryChange={list.setQuery}
          placeholder={t('settings.channels.search', 'Search channels...')}
          onClear={clearFilters}
          active={filtersActive}
        >
          <Select value={platformFilter} onValueChange={setPlatformFilter}>
            <SelectTrigger className="w-full sm:w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('settings.channels.filterAllPlatforms', 'All platforms')}</SelectItem>
              {platformsPresent.map((p) => (
                <SelectItem key={p} value={p}>
                  <span className="flex items-center gap-2">
                    <PlatformIcon platform={p} variant="color" className="size-4" />
                    <span className="capitalize">{p}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('settings.channels.filterAllStatuses', 'All statuses')}</SelectItem>
              <SelectItem value="active">{t('settings.channels.statusActive', 'Active')}</SelectItem>
              <SelectItem value="inactive">{t('settings.channels.statusInactive', 'Inactive')}</SelectItem>
              <SelectItem value="error">{t('settings.channels.statusError', 'Error')}</SelectItem>
            </SelectContent>
          </Select>
        </ListToolbar>
      )}

      {channels.length > 0 && list.filtered.length === 0 && (
        <EmptyState minimal title={t('common.noResults', 'No results found')} />
      )}

      {list.filtered.map((channel) => {
        const isExpanded = expandedId === channel.id
        return (
          <Collapsible
            key={channel.id}
            open={isExpanded}
            onOpenChange={(open) => setExpandedId(open ? channel.id : null)}
          >
            <ChannelCard
              channel={channel}
              expanded={isExpanded}
              testing={testingId === channel.id}
              onToggleExpand={() => setExpandedId(isExpanded ? null : channel.id)}
              onEdit={() => openEdit(channel)}
              onDelete={() => handleDelete(channel.id)}
              onToggle={() => handleToggle(channel)}
              onTest={() => handleTest(channel)}
              // Re-pair (re-scan a fresh QR) is offered for QR channels that
              // aren't currently connected.
              onRepair={
                qrPlatforms.has(channel.platform) && channel.status !== 'active'
                  ? () => setRepairChannel(channel)
                  : undefined
              }
            />
            <CollapsibleContent>
              <div className="border border-t-0 rounded-b-xl bg-card px-4 py-3 space-y-3">
                {channel.webhookUrl && <ChannelWebhookField url={channel.webhookUrl} />}
                {/* Approval requirement toggle (secure default: ON) */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                        {t('settings.channels.approval.title')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('settings.channels.approval.description')}
                      </p>
                    </div>
                    <Switch
                      size="sm"
                      checked={!channel.autoCreateContacts}
                      onCheckedChange={() => handleToggleApproval(channel)}
                    />
                  </div>
                  {channel.autoCreateContacts && (
                    <p className="flex items-start gap-1.5 rounded-lg bg-warning/10 border border-warning/20 px-3 py-2 text-xs text-warning">
                      <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
                      <span>{t('settings.channels.approval.warning')}</span>
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    {t('settings.channels.manageUsers')}
                    {channel.pendingApprovalCount > 0 && (
                      <span className="ml-1.5 inline-flex items-center justify-center size-4 rounded-full bg-amber-500 text-[9px] text-white font-bold align-middle">
                        {channel.pendingApprovalCount}
                      </span>
                    )}
                  </p>
                  <ChannelUserMappings
                    channelId={channel.id}
                    platform={channel.platform}
                    onCountChange={() => fetchChannels()}
                  />
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )
      })}

      <Button variant="outline" onClick={openAdd} className="w-full">
        <Plus className="size-4" />
        {t('settings.channels.add')}
      </Button>

      {/* Create/Edit form dialog */}
      <ChannelFormDialog
        open={modalOpen}
        onOpenChange={setModalOpen}
        onSave={handleCreate}
        onUpdate={handleUpdate}
        onTransfer={handleTransfer}
        channel={editingChannel}
        agents={agents}
      />

      {/* Re-pair (re-scan QR) dialog for QR channels */}
      <ChannelRepairDialog
        open={!!repairChannel}
        onOpenChange={(open) => { if (!open) setRepairChannel(null) }}
        channel={repairChannel}
      />

    </div>
  )
}
