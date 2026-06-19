import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/client/components/ui/button'
import { Plus, Users } from 'lucide-react'
import { EmptyState } from '@/client/components/common/EmptyState'
import { HelpPanel } from '@/client/components/common/HelpPanel'
import { ListToolbar } from '@/client/components/common/ListToolbar'
import { ListPagination } from '@/client/components/common/ListPagination'
import { SettingsListSkeleton } from '@/client/components/common/SettingsListSkeleton'
import { api, toastError } from '@/client/lib/api'
import { useAgentList } from '@/client/hooks/useAgentList'
import { useSSE, useSSEResync } from '@/client/hooks/useSSE'
import { ContactCard, type ContactData, type AgentInfo } from '@/client/components/contacts/ContactCard'
import { ContactFormDialog } from '@/client/components/contacts/ContactFormDialog'

const PAGE_SIZE = 30

export function ContactsSettings() {
  const { t } = useTranslation()
  const [contacts, setContacts] = useState<ContactData[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const { agents: agentList } = useAgentList()
  const agentInfo = new Map<string, AgentInfo>(agentList.map((k) => [k.id, { name: k.name, avatarUrl: k.avatarUrl }]))
  const [modalOpen, setModalOpen] = useState(false)
  const [editingContact, setEditingContact] = useState<ContactData | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [page, setPage] = useState(0) // 0-based

  // Contacts grow unboundedly, so search + pagination run server-side. Debounce
  // the query and reset to the first page whenever it changes.
  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedSearch(searchQuery.trim())
      setPage(0)
    }, 250)
    return () => clearTimeout(id)
  }, [searchQuery])

  const fetchContacts = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      })
      if (debouncedSearch) params.set('search', debouncedSearch)
      const data = await api.get<{ contacts: ContactData[]; total: number; hasMore: boolean }>(`/contacts?${params}`)
      setContacts(data.contacts)
      setTotal(data.total)
    } catch (err) {
      toast.error(t('contacts.fetchError', 'Failed to load contacts'))
    } finally {
      setIsLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, debouncedSearch])

  useEffect(() => {
    fetchContacts()
  }, [fetchContacts])

  // If the total shrinks below the current page (e.g. the last item on the last
  // page was deleted), step back so we never strand the user on an empty page.
  useEffect(() => {
    const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1)
    if (page > maxPage) setPage(maxPage)
  }, [total, page])

  // SSE has no replay — refetch the current page on reconnect/resume.
  useSSEResync(() => { fetchContacts() })

  // Real-time updates via SSE. Refetch (rather than splice) so the paged
  // total/offsets stay correct.
  useSSE({
    'contact:created': () => fetchContacts(),
    'contact:updated': () => fetchContacts(),
    'contact:deleted': () => fetchContacts(),
  })

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const isSearching = debouncedSearch.length > 0
  const showToolbar = total > 0 || isSearching

  const handleDeleteContact = async (id: string) => {
    try {
      await api.delete(`/contacts/${id}`)
      await fetchContacts()
      toast.success(t('settings.contacts.deleted'))
    } catch (err: unknown) {
      toastError(err)
    }
  }

  const handleSaved = async () => {
    await fetchContacts()
    toast.success(editingContact ? t('settings.contacts.saved') : t('settings.contacts.added'))
  }

  const openAdd = () => {
    setEditingContact(null)
    setModalOpen(true)
  }

  const openEdit = (contact: ContactData) => {
    setEditingContact(contact)
    setModalOpen(true)
  }

  if (isLoading) {
    return <SettingsListSkeleton count={3} />
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t('settings.contacts.description')}
        </p>
      </div>

      <HelpPanel
        contentKey="settings.contacts.help.content"
        bulletKeys={[
          'settings.contacts.help.bullet1',
          'settings.contacts.help.bullet2',
          'settings.contacts.help.bullet3',
          'settings.contacts.help.bullet4',
        ]}
        storageKey="help.contacts.open"
      />

      {showToolbar && (
        <ListToolbar
          query={searchQuery}
          onQueryChange={setSearchQuery}
          placeholder={t('settings.contacts.search', 'Search contacts...')}
          onClear={() => setSearchQuery('')}
          active={searchQuery.length > 0}
        />
      )}

      {total === 0 && (
        isSearching ? (
          <EmptyState minimal title={t('common.noResults', 'No results found')} />
        ) : (
          <EmptyState
            icon={Users}
            title={t('settings.contacts.empty')}
            description={t('settings.contacts.emptyDescription')}
            actionLabel={t('settings.contacts.add')}
            onAction={openAdd}
          />
        )
      )}

      {contacts.map((contact) => (
        <ContactCard
          key={contact.id}
          contact={contact}
          agentInfo={agentInfo}
          onEdit={() => openEdit(contact)}
          onDelete={() => handleDeleteContact(contact.id)}
          onRefresh={fetchContacts}
        />
      ))}

      {total > PAGE_SIZE && (
        <ListPagination
          page={page + 1}
          pageCount={pageCount}
          total={total}
          rangeFrom={total === 0 ? 0 : page * PAGE_SIZE + 1}
          rangeTo={Math.min((page + 1) * PAGE_SIZE, total)}
          onPageChange={(p) => setPage(p - 1)}
        />
      )}

      <Button variant="outline" onClick={openAdd} className="w-full">
        <Plus className="size-4" />
        {t('settings.contacts.add')}
      </Button>

      <ContactFormDialog
        open={modalOpen}
        onOpenChange={setModalOpen}
        onSaved={handleSaved}
        contact={editingContact}
      />

    </div>
  )
}
