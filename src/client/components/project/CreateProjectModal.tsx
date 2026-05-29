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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/client/components/ui/select'
import { ModelPicker, modelPickerValue } from '@/client/components/common/ModelPicker'
import { ToolboxMultiSelect } from '@/client/components/toolbox/ToolboxMultiSelect'
import { useModels } from '@/client/hooks/useModels'
import { useToolboxes } from '@/client/hooks/useToolboxes'
import { VaultPatPicker } from '@/client/components/project/VaultPatPicker'
import { GithubRepoPicker } from '@/client/components/project/GithubRepoPicker'
import { getErrorMessage } from '@/client/lib/api'
import { choiceToConfig, type ThinkingChoice } from '@/client/lib/thinking-choice'
import { toast } from 'sonner'
import type { KinThinkingConfig } from '@/shared/types'

interface CreateProjectInputSubset {
  title: string
  description?: string
  githubPatVaultKey?: string | null
  githubRepo?: string | null
  defaultBranch?: string
  model?: string | null
  providerId?: string | null
  thinkingConfig?: KinThinkingConfig | null
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
  const [thinkingChoice, setThinkingChoice] = useState<ThinkingChoice>('inherit')
  const [defaultToolboxIds, setDefaultToolboxIds] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)

  function reset() {
    setTitle('')
    setDescription('')
    setGithubPatVaultKey(null)
    setGithubRepo(null)
    setDefaultBranch('')
    setModel('')
    setProviderId('')
    setThinkingChoice('inherit')
    setDefaultToolboxIds([])
  }

  async function handleSubmit() {
    const trimmed = title.trim()
    if (!trimmed) return
    setSubmitting(true)
    try {
      // model/providerId are coupled — only send when both are set so the
      // server's MODEL_AND_PROVIDER_MUST_BOTH_BE_SET guard never fires.
      const bothSet = !!model && !!providerId
      const project = await onCreate({
        title: trimmed,
        description: description.trim() || undefined,
        // Send only when set so we don't overwrite with empty strings.
        githubPatVaultKey: githubPatVaultKey ?? undefined,
        githubRepo: githubRepo ?? undefined,
        defaultBranch: defaultBranch.trim() || undefined,
        model: bothSet ? model : undefined,
        providerId: bothSet ? providerId : undefined,
        thinkingConfig: thinkingChoice !== 'inherit' ? choiceToConfig(thinkingChoice) : undefined,
        // Empty selection = inherit (built-in default). Only send when chosen.
        defaultToolboxIds: defaultToolboxIds.length > 0 ? defaultToolboxIds : undefined,
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

          {/* Sub-Kin defaults: model + thinking effort. Pre-setting them at
              creation time mirrors the edit modal so the user doesn't have
              to reopen the project to wire them up before spawning tasks. */}
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
            <div className="space-y-1.5">
              <Label htmlFor="project-pat">{t('projects.github.patField')}</Label>
              <VaultPatPicker
                value={githubPatVaultKey}
                onValueChange={setGithubPatVaultKey}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="project-repo">{t('projects.github.repoField')}</Label>
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
              <Label htmlFor="project-default-branch">{t('projects.github.defaultBranchField')}</Label>
              <Input
                id="project-default-branch"
                value={defaultBranch}
                onChange={(e) => setDefaultBranch(e.target.value)}
                placeholder="main"
              />
              <p className="text-xs text-muted-foreground">
                {t('projects.github.defaultBranchHint')}
              </p>
            </div>
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
