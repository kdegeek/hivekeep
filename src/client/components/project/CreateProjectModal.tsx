import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FormDialog } from '@/client/components/common/FormDialog'
import { FormField } from '@/client/components/common/FormField'
import { Input } from '@/client/components/ui/input'
import { MarkdownEditor } from '@/client/components/ui/markdown-editor'
import { Label } from '@/client/components/ui/label'
import { ModelPicker, modelPickerValue } from '@/client/components/common/ModelPicker'
import { ToolboxMultiSelect } from '@/client/components/toolbox/ToolboxMultiSelect'
import { useModels } from '@/client/hooks/useModels'
import { useToolboxes } from '@/client/hooks/useToolboxes'
import { VaultPatPicker } from '@/client/components/project/VaultPatPicker'
import { GithubRepoPicker } from '@/client/components/project/GithubRepoPicker'
import { getErrorMessage } from '@/client/lib/api'
import { choiceToConfig, type ThinkingChoice } from '@/client/lib/thinking-choice'
import { ThinkingEffortSelect } from '@/client/components/common/ThinkingEffortSelect'
import { modelReasoningInfo } from '@/client/lib/model-efforts'
import { toast } from 'sonner'
import type { AgentThinkingConfig } from '@/shared/types'

interface CreateProjectInputSubset {
  title: string
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
}

interface CreateProjectModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (input: CreateProjectInputSubset) => Promise<{ id: string }>
  onCreated?: (projectId: string) => void
}

export function CreateProjectModal({ open, onOpenChange, onCreate, onCreated }: CreateProjectModalProps) {
  const { t } = useTranslation()
  const { llmModels } = useModels()
  const { toolboxes } = useToolboxes()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [githubPatVaultKey, setGithubPatVaultKey] = useState<string | null>(null)
  const [githubRepo, setGithubRepo] = useState<string | null>(null)
  const [defaultBranch, setDefaultBranch] = useState<string>('')
  const [model, setModel] = useState('')
  const [providerId, setProviderId] = useState('')
  const [scoutModel, setScoutModel] = useState('')
  const [scoutProviderId, setScoutProviderId] = useState('')
  const [thinkingChoice, setThinkingChoice] = useState<ThinkingChoice>('inherit')
  const [scoutThinkingChoice, setScoutThinkingChoice] = useState<ThinkingChoice>('inherit')
  const [defaultToolboxIds, setDefaultToolboxIds] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  function reset() {
    setTitle('')
    setDescription('')
    setGithubPatVaultKey(null)
    setGithubRepo(null)
    setDefaultBranch('')
    setModel('')
    setProviderId('')
    setScoutModel('')
    setScoutProviderId('')
    setThinkingChoice('inherit')
    setDefaultToolboxIds([])
    setError('')
  }

  async function handleSubmit() {
    const trimmed = title.trim()
    if (!trimmed) return
    setError('')
    setSubmitting(true)
    try {
      // model/providerId are coupled — only send when both are set so the
      // server's MODEL_AND_PROVIDER_MUST_BOTH_BE_SET guard never fires.
      const bothSet = !!model && !!providerId
      // Scout model/provider are coupled — only send when both are set so the
      // server's SCOUT_MODEL_AND_PROVIDER_MUST_BOTH_BE_SET guard never fires.
      const scoutBothSet = !!scoutModel && !!scoutProviderId
      const project = await onCreate({
        title: trimmed,
        description: description.trim() || undefined,
        // Send only when set so we don't overwrite with empty strings.
        githubPatVaultKey: githubPatVaultKey ?? undefined,
        githubRepo: githubRepo ?? undefined,
        defaultBranch: defaultBranch.trim() || undefined,
        model: bothSet ? model : undefined,
        providerId: bothSet ? providerId : undefined,
        scoutModel: scoutBothSet ? scoutModel : undefined,
        scoutProviderId: scoutBothSet ? scoutProviderId : undefined,
        thinkingConfig: thinkingChoice !== 'inherit' ? choiceToConfig(thinkingChoice) : undefined,
        scoutThinkingConfig: scoutThinkingChoice !== 'inherit' ? choiceToConfig(scoutThinkingChoice) : undefined,
        // Empty selection = inherit (built-in default). Only send when chosen.
        defaultToolboxIds: defaultToolboxIds.length > 0 ? defaultToolboxIds : undefined,
      })
      onCreated?.(project.id)
      reset()
      onOpenChange(false)
    } catch (err) {
      setError(getErrorMessage(err))
      toast.error(getErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => { if (!o) reset(); onOpenChange(o) }}
      title={t('projects.create.title')}
      description={t('projects.create.description')}
      size="2xl"
      error={error}
      onSubmit={handleSubmit}
      isSubmitting={submitting}
      submitDisabled={!title.trim()}
      submitLabel={t('common.create')}
    >
      <FormField label={t('projects.create.titleField')} htmlFor="project-title" required>
        <Input
          id="project-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('projects.create.titlePlaceholder')}
          autoFocus
        />
      </FormField>

      <FormField label={t('projects.create.descriptionField')} hint={t('projects.create.descriptionHint')}>
        <MarkdownEditor
          value={description}
          onChange={setDescription}
          height="280px"
        />
      </FormField>

      {/* Sub-Agent defaults: model + thinking effort. Pre-setting them at
          creation time mirrors the edit modal so the user doesn't have
          to reopen the project to wire them up before spawning tasks. */}
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

      {/* GitHub integration: PAT + repo picker. Optional at create time
          — leaving them blank yields a project with no sub-task worktree
          support, which the user can wire up later from the edit modal. */}
      <div className="space-y-3 border-t border-border pt-4">
        <div className="space-y-0.5">
          <Label>{t('projects.github.sectionTitle')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('projects.github.sectionHint')}
          </p>
        </div>
        <FormField label={t('projects.github.patField')} htmlFor="project-pat">
          <VaultPatPicker
            value={githubPatVaultKey}
            onValueChange={setGithubPatVaultKey}
          />
        </FormField>
        <FormField
          label={t('projects.github.repoField')}
          htmlFor="project-repo"
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
          htmlFor="project-default-branch"
          hint={t('projects.github.defaultBranchHint')}
        >
          <Input
            id="project-default-branch"
            value={defaultBranch}
            onChange={(e) => setDefaultBranch(e.target.value)}
            placeholder="main"
          />
        </FormField>
      </div>
    </FormDialog>
  )
}
