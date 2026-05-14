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

interface CreateProjectModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (input: { title: string; description?: string; githubUrl?: string }) => Promise<{ id: string }>
  onCreated?: (projectId: string) => void
}

export function CreateProjectModal({ open, onOpenChange, onCreate, onCreated }: CreateProjectModalProps) {
  const { t } = useTranslation()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [githubUrl, setGithubUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)

  function reset() {
    setTitle('')
    setDescription('')
    setGithubUrl('')
  }

  async function handleSubmit() {
    const trimmed = title.trim()
    if (!trimmed) return
    setSubmitting(true)
    try {
      const project = await onCreate({
        title: trimmed,
        description: description.trim() || undefined,
        githubUrl: githubUrl.trim() || undefined,
      })
      onCreated?.(project.id)
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
          <DialogTitle>{t('projects.create.title')}</DialogTitle>
          <DialogDescription>{t('projects.create.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="project-title">{t('projects.create.titleField')}</Label>
            <Input
              id="project-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('projects.create.titlePlaceholder')}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('projects.create.descriptionField')}</Label>
            <MarkdownEditor
              value={description}
              onChange={setDescription}
              height="280px"
            />
            <p className="text-xs text-muted-foreground">
              {t('projects.create.descriptionHint')}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-github">{t('projects.create.githubField')}</Label>
            <Input
              id="project-github"
              value={githubUrl}
              onChange={(e) => setGithubUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
            />
          </div>
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
