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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/client/components/ui/select'
import { TagManager } from '@/client/components/project/TagManager'
import { ModelPicker, modelPickerValue } from '@/client/components/common/ModelPicker'
import { ToolboxMultiSelect } from '@/client/components/toolbox/ToolboxMultiSelect'
import { VaultPatPicker } from '@/client/components/project/VaultPatPicker'
import { GithubRepoPicker } from '@/client/components/project/GithubRepoPicker'
import { CloneStatusBlock } from '@/client/components/project/CloneStatusBadge'
import { useModels } from '@/client/hooks/useModels'
import { useToolboxes } from '@/client/hooks/useToolboxes'
import { getErrorMessage } from '@/client/lib/api'
import { configToChoice, choiceToConfig, type ThinkingChoice } from '@/client/lib/thinking-choice'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import type { Project, KinThinkingConfig } from '@/shared/types'

interface EditProjectModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: Project
  onSave: (input: {
    title?: string
    description?: string
    githubPatVaultKey?: string | null
    githubRepo?: string | null
    defaultBranch?: string
    model?: string | null
    providerId?: string | null
    thinkingConfig?: KinThinkingConfig | null
    defaultToolboxIds?: string[] | null
  }) => Promise<unknown>
  onDelete: () => Promise<void>
}

/** Order-insensitive equality for two toolbox-id selections. */
function sameToolboxIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((id, i) => id === sb[i])
}

export function EditProjectModal({ open, onOpenChange, project, onSave, onDelete }: EditProjectModalProps) {
  const { t } = useTranslation()
  const { llmModels } = useModels()
  const { toolboxes } = useToolboxes()
  const [title, setTitle] = useState(project.title)
  const [description, setDescription] = useState(project.description)
  const [githubPatVaultKey, setGithubPatVaultKey] = useState<string | null>(project.githubPatVaultKey)
  const [githubRepo, setGithubRepo] = useState<string | null>(project.githubRepo)
  const [defaultBranch, setDefaultBranch] = useState(project.defaultBranch ?? 'main')
  const [model, setModel] = useState(project.model ?? '')
  const [providerId, setProviderId] = useState(project.providerId ?? '')
  const [thinkingChoice, setThinkingChoice] = useState<ThinkingChoice>(configToChoice(project.thinkingConfig))
  const [defaultToolboxIds, setDefaultToolboxIds] = useState<string[]>(project.defaultToolboxIds ?? [])
  const [submitting, setSubmitting] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Reset fields when project changes or modal opens
  useEffect(() => {
    if (open) {
      setTitle(project.title)
      setDescription(project.description)
      setGithubPatVaultKey(project.githubPatVaultKey)
      setGithubRepo(project.githubRepo)
      setDefaultBranch(project.defaultBranch ?? 'main')
      setModel(project.model ?? '')
      setProviderId(project.providerId ?? '')
      setThinkingChoice(configToChoice(project.thinkingConfig))
      setDefaultToolboxIds(project.defaultToolboxIds ?? [])
    }
  }, [open, project])

  const initialThinkingChoice = configToChoice(project.thinkingConfig)
  const initialToolboxIds = project.defaultToolboxIds ?? []
  const toolboxesChanged = !sameToolboxIds(defaultToolboxIds, initialToolboxIds)
  const hasChanges =
    title !== project.title ||
    description !== project.description ||
    githubPatVaultKey !== project.githubPatVaultKey ||
    githubRepo !== project.githubRepo ||
    defaultBranch !== (project.defaultBranch ?? 'main') ||
    (model || null) !== project.model ||
    (providerId || null) !== project.providerId ||
    thinkingChoice !== initialThinkingChoice ||
    toolboxesChanged

  async function handleSave() {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return
    setSubmitting(true)
    try {
      const modelChanged =
        (model || null) !== project.model || (providerId || null) !== project.providerId
      const thinkingChanged = thinkingChoice !== initialThinkingChoice
      await onSave({
        title: trimmedTitle !== project.title ? trimmedTitle : undefined,
        description: description !== project.description ? description : undefined,
        githubPatVaultKey:
          githubPatVaultKey !== project.githubPatVaultKey ? githubPatVaultKey : undefined,
        githubRepo:
          githubRepo !== project.githubRepo ? githubRepo : undefined,
        defaultBranch:
          defaultBranch !== (project.defaultBranch ?? 'main') ? defaultBranch : undefined,
        model: modelChanged ? (model || null) : undefined,
        providerId: modelChanged ? (providerId || null) : undefined,
        thinkingConfig: thinkingChanged ? choiceToConfig(thinkingChoice) : undefined,
        // Empty selection clears to null (inherit built-in default).
        defaultToolboxIds: toolboxesChanged
          ? (defaultToolboxIds.length > 0 ? defaultToolboxIds : null)
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

            {/* GitHub integration: PAT vault key + repo picker. When a repo
                is set, the server kicks off a background clone whose status
                is shown by <CloneStatusBlock> (with Retry on error). */}
            <div className="space-y-3 border-t border-border pt-4">
              <div className="space-y-0.5">
                <Label>{t('projects.github.sectionTitle')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('projects.github.sectionHint')}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>{t('projects.github.patField')}</Label>
                <VaultPatPicker
                  value={githubPatVaultKey}
                  onValueChange={setGithubPatVaultKey}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('projects.github.repoField')}</Label>
                <GithubRepoPicker
                  value={githubRepo}
                  onValueChange={(repo, branch) => {
                    setGithubRepo(repo)
                    if (branch) setDefaultBranch(branch)
                  }}
                  patVaultKey={githubPatVaultKey}
                />
                {!githubPatVaultKey && (
                  <p className="text-xs text-muted-foreground">
                    {t('projects.github.repoNeedsPat')}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-project-default-branch">{t('projects.github.defaultBranchField')}</Label>
                <Input
                  id="edit-project-default-branch"
                  value={defaultBranch}
                  onChange={(e) => setDefaultBranch(e.target.value)}
                  placeholder="main"
                />
                <p className="text-xs text-muted-foreground">
                  {t('projects.github.defaultBranchHint')}
                </p>
              </div>
              <CloneStatusBlock
                projectId={project.id}
                status={project.cloneStatus}
                errorMessage={project.cloneError}
                hasRepo={!!project.githubRepo}
              />
            </div>

            <div className="space-y-1.5">
              <Label>{t('projects.edit.modelField')}</Label>
              <ModelPicker
                models={llmModels}
                value={modelPickerValue(model, providerId)}
                onValueChange={(modelId, pid) => {
                  setModel(modelId)
                  setProviderId(pid)
                }}
                placeholder={t('projects.edit.modelPlaceholder')}
                allowClear
              />
              <p className="text-xs text-muted-foreground">
                {t('projects.edit.modelHint')}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>{t('projects.edit.thinkingField')}</Label>
              <Select
                value={thinkingChoice}
                onValueChange={(v) => setThinkingChoice(v as ThinkingChoice)}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">
                    <span className="italic text-muted-foreground">
                      {t('projects.edit.thinkingInherit')}
                    </span>
                  </SelectItem>
                  <SelectItem value="off">{t('chat.thinkingPicker.effort.off')}</SelectItem>
                  <SelectItem value="low">{t('chat.thinkingPicker.effort.low')}</SelectItem>
                  <SelectItem value="medium">{t('chat.thinkingPicker.effort.medium')}</SelectItem>
                  <SelectItem value="high">{t('chat.thinkingPicker.effort.high')}</SelectItem>
                  <SelectItem value="max">{t('chat.thinkingPicker.effort.max')}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t('projects.edit.thinkingHint')}
              </p>
            </div>

            {/* Default toolboxes for tasks started on this project's tickets.
                Empty = inherit the built-in default; an explicit pick at
                task-start time still overrides this. */}
            {toolboxes.length > 0 && (
              <div className="space-y-1.5">
                <Label>{t('projects.edit.toolboxesField')}</Label>
                <ToolboxMultiSelect
                  toolboxes={toolboxes}
                  selected={defaultToolboxIds}
                  onChange={setDefaultToolboxIds}
                />
                <p className="text-xs text-muted-foreground">
                  {t('projects.edit.toolboxesHint')}
                </p>
              </div>
            )}

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
