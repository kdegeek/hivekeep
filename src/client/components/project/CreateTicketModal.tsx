import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/client/components/ui/dialog'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import { MarkdownEditor } from '@/client/components/ui/markdown-editor'
import { Label } from '@/client/components/ui/label'
import { getErrorMessage } from '@/client/lib/api'
import { toast } from 'sonner'
import { cn } from '@/client/lib/utils'
import type { ProjectTag, TicketStatus } from '@/shared/types'

interface CreateTicketModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  availableTags: ProjectTag[]
  onCreate: (input: {
    title: string
    description?: string
    status?: TicketStatus
    tagIds?: string[]
  }) => Promise<unknown>
}

export function CreateTicketModal({ open, onOpenChange, availableTags, onCreate }: CreateTicketModalProps) {
  const { t } = useTranslation()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)

  function reset() {
    setTitle('')
    setDescription('')
    setSelectedTagIds([])
  }

  function toggleTag(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((t) => t !== tagId) : [...prev, tagId],
    )
  }

  async function handleSubmit() {
    const trimmed = title.trim()
    if (!trimmed) return
    setSubmitting(true)
    try {
      await onCreate({
        title: trimmed,
        description: description.trim() || undefined,
        tagIds: selectedTagIds.length > 0 ? selectedTagIds : undefined,
      })
      reset()
      onOpenChange(false)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o) }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('projects.ticket.create.title')}</DialogTitle>
          <DialogDescription>{t('projects.ticket.create.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="ticket-title">{t('projects.ticket.create.titleField')}</Label>
            <Input
              id="ticket-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('projects.ticket.create.titlePlaceholder')}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('projects.ticket.create.descriptionField')}</Label>
            <MarkdownEditor
              value={description}
              onChange={setDescription}
              height="240px"
            />
          </div>
          {availableTags.length > 0 && (
            <div className="space-y-1.5">
              <Label>{t('projects.ticket.create.tagsField')}</Label>
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
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!title.trim() || submitting}>
            {t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
