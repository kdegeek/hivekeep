import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Input } from '@/client/components/ui/input'
import { Button } from '@/client/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/client/components/ui/select'
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
import { AlertTriangle, Brain, ChevronLeft, ChevronRight, Plus, Search } from 'lucide-react'
import { EmptyState } from '@/client/components/common/EmptyState'
import { api, toastError } from '@/client/lib/api'
import { useMemories } from '@/client/hooks/useMemories'
import { useHasCapability } from '@/client/hooks/useHasCapability'
import { MemoryCard } from '@/client/components/memory/MemoryCard'
import { MemoryFormDialog } from '@/client/components/memory/MemoryFormDialog'
import { AgentSelector } from '@/client/components/common/AgentSelector'
import type { AgentOption } from '@/client/components/common/AgentSelectItem'
import { MEMORY_CATEGORIES } from '@/shared/constants'
import type { MemorySummary, MemoryCategory, MemoryScope } from '@/shared/types'

interface MemoryListProps {
  agentId?: string | null
  compact?: boolean
}

export function MemoryList({ agentId, compact }: MemoryListProps) {
  const { t } = useTranslation()
  const hasEmbedding = useHasCapability('embedding')
  const {
    memories,
    isLoading,
    page,
    setPage,
    total,
    hasMore,
    pageSize,
    applyFilters,
    createMemory,
    updateMemory,
    deleteMemory,
  } = useMemories(agentId)

  // Local UI state
  const [searchQuery, setSearchQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [scopeFilter, setScopeFilter] = useState<string>('all')
  const [agentFilter, setAgentFilter] = useState<string>('all')
  const [agentNames, setAgentNames] = useState<Map<string, string>>(new Map())
  const [agentAvatars, setAgentAvatars] = useState<Map<string, string | null>>(new Map())
  const [agents, setAgents] = useState<AgentOption[]>([])

  const [modalOpen, setModalOpen] = useState(false)
  const [editingMemory, setEditingMemory] = useState<MemorySummary | null>(null)
  const [deletingMemory, setDeletingMemory] = useState<MemorySummary | null>(null)
  const deletingMemoryRef = useRef<MemorySummary | null>(null)

  // Fetch Agents for global mode (filter + form dialog + card agent name)
  useEffect(() => {
    if (!agentId) {
      api
        .get<{ agents: { id: string; name: string; role: string; avatarUrl: string | null }[] }>('/agents')
        .then((data) => {
          setAgents(data.agents)
          setAgentNames(new Map(data.agents.map((k) => [k.id, k.name])))
          setAgentAvatars(new Map(data.agents.map((k) => [k.id, k.avatarUrl])))
        })
        .catch(() => {})
    }
  }, [agentId])

  // Apply server-side filters when dropdowns change
  useEffect(() => {
    const newFilters: { category?: MemoryCategory; agentId?: string; scope?: MemoryScope } = {}
    if (categoryFilter !== 'all') newFilters.category = categoryFilter as MemoryCategory
    if (scopeFilter !== 'all') newFilters.scope = scopeFilter as MemoryScope
    if (!agentId && agentFilter !== 'all') newFilters.agentId = agentFilter
    applyFilters(newFilters)
  }, [categoryFilter, scopeFilter, agentFilter, applyFilters, agentId])

  // Client-side text search
  const filteredMemories = useMemo(() => {
    if (!searchQuery.trim()) return memories
    const q = searchQuery.toLowerCase()
    return memories.filter(
      (m) =>
        m.content.toLowerCase().includes(q) ||
        (m.subject && m.subject.toLowerCase().includes(q)),
    )
  }, [memories, searchQuery])

  // CRUD handlers
  const handleSave = async (targetAgentId: string, data: { content: string; category: MemoryCategory; subject?: string; scope?: MemoryScope }) => {
    await createMemory(targetAgentId, data)
    toast.success(t('settings.memories.added'))
  }

  const handleUpdate = async (memoryId: string, targetAgentId: string, updates: { content?: string; category?: MemoryCategory; subject?: string | null; scope?: MemoryScope }) => {
    await updateMemory(memoryId, targetAgentId, updates)
    toast.success(t('settings.memories.saved'))
  }

  const handleDelete = async () => {
    const target = deletingMemoryRef.current
    if (!target) return
    deletingMemoryRef.current = null
    setDeletingMemory(null)
    try {
      await deleteMemory(target.id, target.agentId)
      toast.success(t('settings.memories.deleted'))
    } catch (err: unknown) {
      toastError(err)
    }
  }

  const openAdd = () => {
    setEditingMemory(null)
    setModalOpen(true)
  }

  const openEdit = (memory: MemorySummary) => {
    setEditingMemory(memory)
    setModalOpen(true)
  }

  return (
    <div className="space-y-4">
      {/* Embedding capability banner — without it, hybrid search drops
          to FTS5 keyword-only and the recall/memorize tools can't run. */}
      {!hasEmbedding && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
          <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
              {t('settings.memories.noEmbedding')}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('settings.memories.noEmbeddingHint')}
            </p>
          </div>
        </div>
      )}

      {/* Filters row */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('settings.memories.search')}
            className="pl-8"
          />
        </div>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('settings.memories.filterAll')}</SelectItem>
            {MEMORY_CATEGORIES.map((cat) => (
              <SelectItem key={cat} value={cat}>
                {t(`settings.memories.category.${cat}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={scopeFilter} onValueChange={setScopeFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('settings.memories.scopeAll')}</SelectItem>
            <SelectItem value="private">{t('settings.memories.scopePrivate')}</SelectItem>
            <SelectItem value="shared">{t('settings.memories.scopeShared')}</SelectItem>
          </SelectContent>
        </Select>
        {!agentId && (
          <AgentSelector
            value={agentFilter}
            onValueChange={setAgentFilter}
            agents={agents}
            placeholder={t('settings.memories.filterAllAgents')}
            noneLabel={t('settings.memories.filterAllAgents')}
            noneValue="all"
            triggerClassName="w-[200px] h-auto min-h-9"
          />
        )}
      </div>

      {/* Count */}
      {!isLoading && (
        <p className="text-xs text-muted-foreground">
          {searchQuery.trim()
            ? t('settings.memories.count', { count: filteredMemories.length })
            : t('settings.memories.count', { count: total })}
        </p>
      )}

      {/* Memory list */}
      {isLoading ? (
        <EmptyState minimal title={t('common.loading')} />
      ) : filteredMemories.length === 0 ? (
        searchQuery || categoryFilter !== 'all' || scopeFilter !== 'all' || agentFilter !== 'all' ? (
          <EmptyState minimal title={t('settings.memories.noResults')} />
        ) : (
          <EmptyState
            icon={Brain}
            title={t('settings.memories.empty')}
            description={t('settings.memories.emptyDescription')}
            actionLabel={t('settings.memories.add')}
            onAction={openAdd}
          />
        )
      ) : (
        <div className="space-y-2">
          {filteredMemories.map((memory) => (
            <MemoryCard
              key={memory.id}
              memory={memory}
              agentName={agentNames.get(memory.agentId)}
              agentAvatarUrl={agentAvatars.get(memory.agentId)}
              showAgentName={!agentId}
              onEdit={() => openEdit(memory)}
              onDelete={() => { deletingMemoryRef.current = memory; setDeletingMemory(memory) }}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {total > pageSize && (
        <div className="flex items-center justify-between pt-1">
          <p className="text-xs text-muted-foreground">
            {t('settings.memories.pagination', {
              from: page * pageSize + 1,
              to: Math.min((page + 1) * pageSize, total),
              total,
            })}
          </p>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft className="size-4" />
              {t('common.previous')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!hasMore}
              onClick={() => setPage(page + 1)}
            >
              {t('common.next')}
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Add button */}
      <Button type="button" variant="outline" onClick={openAdd} className="w-full">
        <Plus className="size-4" />
        {t('settings.memories.add')}
      </Button>

      {/* Form dialog (add/edit) */}
      <MemoryFormDialog
        open={modalOpen}
        onOpenChange={setModalOpen}
        onSave={handleSave}
        onUpdate={handleUpdate}
        memory={editingMemory}
        agentId={agentId}
        agents={agents}
      />

      {/* Delete confirmation */}
      <AlertDialog open={!!deletingMemory} onOpenChange={(v) => { if (!v) { setDeletingMemory(null) } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.memories.delete')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.memories.deleteConfirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDelete}>
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
