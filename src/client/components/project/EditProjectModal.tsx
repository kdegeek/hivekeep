import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/client/components/ui/dialog'
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
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import { MarkdownEditor } from '@/client/components/ui/markdown-editor'
import { Label } from '@/client/components/ui/label'
import { TagManager } from '@/client/components/project/TagManager'
import { getErrorMessage } from '@/client/lib/api'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import type { Project } from '@/shared/types'

interface EditProjectModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: Project
  onSave: (input: { title?: string; description?: string; githubUrl?: string | null }) => Promise<unknown>
  onDelete: () => Promise<void>
}

export function EditProjectModal({ open, onOpenChange, project, onSave, onDelete }: EditProjectModalProps) {
  const { t } = useTranslation()
  const [title, setTitle] = useState(project.title)
  const [description, setDescription] = useState(project.description)
  const [githubUrl, setGithubUrl] = useState(project.githubUrl ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Reset fields when project changes or modal opens
  useEffect(() => {
    if (open) {
      setTitle(project.title)
      setDescription(project.description)
      setGithubUrl(project.githubUrl ?? '')
    }
  }, [open, project])

  const hasChanges =
    title !== project.title ||
    description !== project.description ||
    (githubUrl || null) !== project.githubUrl

  async function handleSave() {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return
    setSubmitting(true)
    try {
      await onSave({
        title: trimmedTitle !== project.title ? trimmedTitle : undefined,
        description: description !== project.description ? description : undefined,
        githubUrl:
          (githubUrl || null) !== project.githubUrl
            ? (githubUrl.trim() || null)
            : undefined,
      })
      onOpenChange(false)
    } catch (err) {
      toast.error(getErrorMessage(err))
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
      toast.error(getErrorMessage(err))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('projects.edit.title')}</DialogTitle>
            <DialogDescription>{t('projects.edit.description')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="edit-project-title">{t('projects.create.titleField')}</Label>
              <Input
                id="edit-project-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
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
              <Label htmlFor="edit-project-github">{t('projects.create.githubField')}</Label>
              <Input
                id="edit-project-github"
                value={githubUrl}
                onChange={(e) => setGithubUrl(e.target.value)}
                placeholder="https://github.com/owner/repo"
              />
            </div>

            <div className="space-y-1.5 border-t border-border pt-4">
              <Label>{t('projects.edit.tagsSection')}</Label>
              <TagManager projectId={project.id} tags={project.tags} />
            </div>
          </div>

          <DialogFooter className="flex flex-row justify-between sm:justify-between gap-2">
            <Button
              variant="ghost"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setDeleteOpen(true)}
              disabled={submitting}
            >
              <Trash2 className="mr-1 size-4" />
              {t('projects.edit.delete')}
            </Button>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleSave} disabled={!hasChanges || !title.trim() || submitting}>
                {t('common.save')}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('projects.edit.deleteConfirm.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('projects.edit.deleteConfirm.description', { title: project.title })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? t('common.loading') : t('projects.edit.deleteConfirm.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
