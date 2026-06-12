import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FormDialog } from '@/client/components/common/FormDialog'
import { FormField } from '@/client/components/common/FormField'
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
import { ModelPicker, modelPickerValue } from '@/client/components/common/ModelPicker'
import { ToolboxMultiSelect } from '@/client/components/toolbox/ToolboxMultiSelect'
import { VaultPatPicker } from '@/client/components/project/VaultPatPicker'
import { GithubRepoPicker } from '@/client/components/project/GithubRepoPicker'
import { CloneStatusBlock } from '@/client/components/project/CloneStatusBadge'
import { useModels } from '@/client/hooks/useModels'
import { useToolboxes } from '@/client/hooks/useToolboxes'
import { getErrorMessage } from '@/client/lib/api'
import { configToChoice, choiceToConfig, type ThinkingChoice } from '@/client/lib/thinking-choice'
import { ThinkingEffortSelect } from '@/client/components/common/ThinkingEffortSelect'
import { modelReasoningInfo } from '@/client/lib/model-efforts'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import type { Project, AgentThinkingConfig } from '@/shared/types'

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
    scoutModel?: string | null
    scoutProviderId?: string | null
    scoutThinkingConfig?: AgentThinkingConfig | null
    thinkingConfig?: AgentThinkingConfig | null
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
  const [scoutModel, setScoutModel] = useState(project.scoutModel ?? '')
  const [scoutProviderId, setScoutProviderId] = useState(project.scoutProviderId ?? '')
  const [thinkingChoice, setThinkingChoice] = useState<ThinkingChoice>(configToChoice(project.thinkingConfig))
  const [scoutThinkingChoice, setScoutThinkingChoice] = useState<ThinkingChoice>(configToChoice(project.scoutThinkingConfig))
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
      setScoutModel(project.scoutModel ?? '')
      setScoutProviderId(project.scoutProviderId ?? '')
      setThinkingChoice(configToChoice(project.thinkingConfig))
      setScoutThinkingChoice(configToChoice(project.scoutThinkingConfig))
      setDefaultToolboxIds(project.defaultToolboxIds ?? [])
    }
  }, [open, project])

  const initialThinkingChoice = configToChoice(project.thinkingConfig)
  const initialScoutThinkingChoice = configToChoice(project.scoutThinkingConfig)
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
    (scoutModel || null) !== (project.scoutModel ?? null) ||
    (scoutProviderId || null) !== (project.scoutProviderId ?? null) ||
    thinkingChoice !== initialThinkingChoice ||
    scoutThinkingChoice !== initialScoutThinkingChoice ||
    toolboxesChanged

  async function handleSave() {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return
    setSubmitting(true)
    try {
      const modelChanged =
        (model || null) !== project.model || (providerId || null) !== project.providerId
      // Scout model/provider are coupled — a partial pair collapses to null
      // (inherit), mirroring the server's coupled-pair validation.
      const scoutBothSet = !!scoutModel && !!scoutProviderId
      const effectiveScoutModel = scoutBothSet ? scoutModel : null
      const effectiveScoutProviderId = scoutBothSet ? scoutProviderId : null
      const scoutChanged =
        effectiveScoutModel !== (project.scoutModel ?? null) ||
        effectiveScoutProviderId !== (project.scoutProviderId ?? null)
      const thinkingChanged = thinkingChoice !== initialThinkingChoice
      const scoutThinkingChanged = scoutThinkingChoice !== initialScoutThinkingChoice
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
        scoutModel: scoutChanged ? effectiveScoutModel : undefined,
        scoutProviderId: scoutChanged ? effectiveScoutProviderId : undefined,
        thinkingConfig: thinkingChanged ? choiceToConfig(thinkingChoice) : undefined,
        scoutThinkingConfig: scoutThinkingChanged ? choiceToConfig(scoutThinkingChoice) : undefined,
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
      <FormDialog
        open={open}
        onOpenChange={onOpenChange}
        title={t('projects.edit.title')}
        description={t('projects.edit.description')}
        size="2xl"
        onSubmit={handleSave}
        isSubmitting={submitting}
        submitDisabled={!hasChanges || !title.trim()}
        footer={
          <div className="flex w-full flex-row items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setDeleteOpen(true)}
              disabled={submitting}
            >
              <Trash2 className="mr-1 size-4" />
              {t('projects.edit.delete')}
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={!hasChanges || !title.trim() || submitting}>
                {t('common.save')}
              </Button>
            </div>
          </div>
        }
      >
        <FormField label={t('projects.create.titleField')} htmlFor="edit-project-title">
          <Input
            id="edit-project-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </FormField>

        <FormField label={t('projects.create.descriptionField')} hint={t('projects.create.descriptionHint')}>
          <MarkdownEditor
            value={description}
            onChange={setDescription}
            height="280px"
          />
        </FormField>

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
          <FormField label={t('projects.github.patField')}>
            <VaultPatPicker
              value={githubPatVaultKey}
              onValueChange={setGithubPatVaultKey}
            />
          </FormField>
          <FormField
            label={t('projects.github.repoField')}
            hint={!githubPatVaultKey ? t('projects.github.repoNeedsPat') : undefined}
          >
            <GithubRepoPicker
              value={githubRepo}
              onValueChange={(repo, branch) => {
                setGithubRepo(repo)
                if (branch) setDefaultBranch(branch)
              }}
              patVaultKey={githubPatVaultKey}
            />
          </FormField>
          <FormField
            label={t('projects.github.defaultBranchField')}
            htmlFor="edit-project-default-branch"
            hint={t('projects.github.defaultBranchHint')}
          >
            <Input
              id="edit-project-default-branch"
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              placeholder="main"
            />
          </FormField>
          <CloneStatusBlock
            projectId={project.id}
            status={project.cloneStatus}
            errorMessage={project.cloneError}
            hasRepo={!!project.githubRepo}
          />
        </div>

        <FormField label={t('projects.edit.modelField')} hint={t('projects.edit.modelHint')}>
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
        </FormField>

        {/* Default scout model for tasks on this project's tickets.
            Empty = inherit the global scout default, then the Agent's model. */}
        <FormField label={t('projects.edit.scoutModelField')} hint={t('projects.edit.scoutModelHint')}>
          <ModelPicker
            models={llmModels}
            value={modelPickerValue(scoutModel, scoutProviderId)}
            onValueChange={(modelId, pid) => {
              setScoutModel(modelId)
              setScoutProviderId(pid)
            }}
            placeholder={t('projects.edit.scoutModelPlaceholder')}
            allowClear
            clearLabel={t('projects.edit.scoutModelPlaceholder')}
          />
        </FormField>

        <FormField label={t('projects.edit.scoutThinkingField')} hint={t('projects.edit.scoutThinkingHint')}>
          <ThinkingEffortSelect
            value={scoutThinkingChoice}
            onChange={setScoutThinkingChoice}
            inheritLabel={t('projects.edit.scoutThinkingInherit')}
            reasoning={scoutModel
              ? modelReasoningInfo(llmModels.find((m) => m.id === scoutModel && (!scoutProviderId || m.providerId === scoutProviderId)))
              : undefined}
          />
        </FormField>

        <FormField label={t('projects.edit.thinkingField')} hint={t('projects.edit.thinkingHint')}>
          <ThinkingEffortSelect
            value={thinkingChoice}
            onChange={setThinkingChoice}
            inheritLabel={t('projects.edit.thinkingInherit')}
          />
        </FormField>

        {/* Default toolboxes for tasks started on this project's tickets.
            Empty = inherit the built-in default; an explicit pick at
            task-start time still overrides this. */}
        {toolboxes.length > 0 && (
          <FormField label={t('projects.edit.toolboxesField')} hint={t('projects.edit.toolboxesHint')}>
            <ToolboxMultiSelect
              toolboxes={toolboxes}
              selected={defaultToolboxIds}
              onChange={setDefaultToolboxIds}
            />
          </FormField>
        )}

        <div className="space-y-2 border-t border-border pt-4">
          <Label>{t('projects.edit.tagsSection')}</Label>
          <TagManager projectId={project.id} tags={project.tags} />
        </div>
      </FormDialog>

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
