import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/client/components/ui/select'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import { MarkdownEditor } from '@/client/components/ui/markdown-editor'
import { FormDialog } from '@/client/components/common/FormDialog'
import { FormField } from '@/client/components/common/FormField'
import { getErrorMessage } from '@/client/lib/api'
import { Loader2, Trash2 } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import { formatTicketRef } from '@/client/lib/ticket-ref'
import { TICKET_STATUSES } from '@/shared/constants'
import type { ProjectTag, Ticket, TicketStatus } from '@/shared/types'

interface EditTicketModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  ticket: Ticket
  /** Project slug used to qualify the ticket ref (e.g. hivekeep#42). Optional:
   *  falls back to a bare #42 when absent or empty. */
  projectSlug?: string | null
  availableTags: ProjectTag[]
  onSave: (input: {
    title?: string
    description?: string
    status?: TicketStatus
    tagIds?: string[]
  }) => Promise<unknown>
  onDelete: () => Promise<void>
}

export function EditTicketModal({ open, onOpenChange, ticket, projectSlug, availableTags, onSave, onDelete }: EditTicketModalProps) {
  const { t } = useTranslation()
  const ticketRef = formatTicketRef(ticket.number, projectSlug)
  const [title, setTitle] = useState(ticket.title)
  const [description, setDescription] = useState(ticket.description)
  const [status, setStatus] = useState<TicketStatus>(ticket.status)
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(ticket.tags.map((tg) => tg.id))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Reset fields whenever the modal (re)opens or the ticket changes
  useEffect(() => {
    if (open) {
      setTitle(ticket.title)
      setDescription(ticket.description)
      setStatus(ticket.status)
      setSelectedTagIds(ticket.tags.map((tg) => tg.id))
      setError(null)
    }
  }, [open, ticket])

  function toggleTag(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((t) => t !== tagId) : [...prev, tagId],
    )
  }

  const currentTagIds = ticket.tags.map((tg) => tg.id).sort().join(',')
  const draftTagIds = [...selectedTagIds].sort().join(',')
  const hasChanges =
    title !== ticket.title ||
    description !== ticket.description ||
    status !== ticket.status ||
    draftTagIds !== currentTagIds

  async function handleSave() {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return
    setError(null)
    setSubmitting(true)
    try {
      await onSave({
        title: trimmedTitle !== ticket.title ? trimmedTitle : undefined,
        description: description !== ticket.description ? description : undefined,
        status: status !== ticket.status ? status : undefined,
        tagIds: draftTagIds !== currentTagIds ? selectedTagIds : undefined,
      })
      onOpenChange(false)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete() {
    setDeleting(true)
    try {
      await onDelete()
      setDeleteOpen(false)
      onOpenChange(false)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <FormDialog
        open={open}
        onOpenChange={onOpenChange}
        title={
          <span className="flex items-center gap-2">
            {ticketRef && (
              <span
                className="font-mono text-xs font-normal text-muted-foreground"
                aria-label={t('projects.ticket.panel.ticketRef', { ref: ticketRef })}
              >
                {ticketRef}
              </span>
            )}
            <span>{t('projects.ticket.edit.title')}</span>
          </span>
        }
        description={t('projects.ticket.edit.description')}
        size="2xl"
        error={error}
        onSubmit={handleSave}
        isSubmitting={submitting}
        submitDisabled={!hasChanges || !title.trim()}
        submitLabel={t('common.save')}
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive sm:mr-auto"
              onClick={() => setDeleteOpen(true)}
              disabled={submitting}
            >
              <Trash2 className="mr-1 size-4" />
              {t('projects.ticket.panel.delete')}
            </Button>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={!hasChanges || !title.trim() || submitting}
              className="btn-shine"
            >
              {submitting && <Loader2 className="size-4 animate-spin" />}
              {t('common.save')}
            </Button>
          </>
        }
      >
        <FormField label={t('projects.ticket.create.titleField')} htmlFor="edit-ticket-title">
          <Input
            id="edit-ticket-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </FormField>

        <FormField label={t('projects.ticket.panel.status')} htmlFor="edit-ticket-status">
          <Select value={status} onValueChange={(v) => setStatus(v as TicketStatus)}>
            <SelectTrigger id="edit-ticket-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TICKET_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`projects.status.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>

        <FormField label={t('projects.ticket.create.descriptionField')}>
          <MarkdownEditor
            value={description}
            onChange={setDescription}
            height="240px"
          />
        </FormField>

        {availableTags.length > 0 && (
          <FormField label={t('projects.ticket.create.tagsField')}>
            <div className="flex flex-wrap gap-1.5">
              {availableTags.map((tag) => {
                const selected = selectedTagIds.includes(tag.id)
                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => toggleTag(tag.id)}
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                      selected
                        ? 'border-transparent'
                        : 'border-border bg-transparent text-muted-foreground hover:bg-muted',
                    )}
                    style={
                      selected
                        ? {
                            backgroundColor: `${tag.color}20`,
                            color: tag.color,
                            borderColor: `${tag.color}40`,
                          }
                        : undefined
                    }
                  >
                    {tag.label}
                  </button>
                )
              })}
            </div>
          </FormField>
        )}
      </FormDialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('projects.ticket.panel.deleteConfirm.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('projects.ticket.panel.deleteConfirm.description', { title: ticket.title })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? t('common.loading') : t('projects.ticket.panel.deleteConfirm.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
