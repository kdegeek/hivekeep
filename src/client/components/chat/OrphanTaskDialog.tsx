import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, getErrorMessage } from '@/client/lib/api'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/client/components/ui/dialog'
import { Button } from '@/client/components/ui/button'
import { Label } from '@/client/components/ui/label'
import { Input } from '@/client/components/ui/input'
import { Textarea } from '@/client/components/ui/textarea'
import { ToolboxMultiSelect } from '@/client/components/toolbox/ToolboxMultiSelect'
import { ModelPicker, modelPickerValue } from '@/client/components/common/ModelPicker'
import { ThinkingEffortSelect } from '@/client/components/common/ThinkingEffortSelect'
import { useToolboxes } from '@/client/hooks/useToolboxes'
import { useModels } from '@/client/hooks/useModels'
import { choiceToConfig, type ThinkingChoice } from '@/client/lib/thinking-choice'
import { toast } from 'sonner'
import type { KinThinkingConfig } from '@/shared/types'

interface OrphanTaskDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  kinId: string
  kinName: string
}

const PROMPT_MAX = 2000
const TITLE_MAX = 120

/**
 * Launch a standalone (orphan) task on a Kin — no project/ticket binding.
 * The user picks a prompt and, optionally, overrides for model, reasoning
 * effort, and toolboxes. Posts to `POST /api/kins/:id/tasks`; the result is
 * deposited back into the Kin's main session (async mode).
 *
 * All overrides default to "inherit" (empty model / 'inherit' effort / no
 * toolbox selection) so leaving them untouched falls back to the Kin's own
 * model + config and the built-in default toolbox.
 */
export function OrphanTaskDialog({ open, onOpenChange, kinId, kinName }: OrphanTaskDialogProps) {
  const { t } = useTranslation()
  const { toolboxes } = useToolboxes()
  const { llmModels, isLoading: modelsLoading } = useModels()
  const [prompt, setPrompt] = useState('')
  const [title, setTitle] = useState('')
  const [selectedToolboxIds, setSelectedToolboxIds] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [providerId, setProviderId] = useState('')
  const [thinkingChoice, setThinkingChoice] = useState<ThinkingChoice>('inherit')
  const [submitting, setSubmitting] = useState(false)

  // Reset every field when the dialog closes so a previous draft never leaks
  // into the next launch.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      setPrompt('')
      setTitle('')
      setSelectedToolboxIds([])
      setModel('')
      setProviderId('')
      setThinkingChoice('inherit')
    }
    wasOpen.current = open
  }, [open])

  const promptLength = prompt.length
  const promptOverLimit = promptLength > PROMPT_MAX
  const canSubmit = prompt.trim().length > 0 && !promptOverLimit && !submitting

  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const body: {
        prompt: string
        title?: string
        toolboxIds?: string[]
        model?: string
        providerId?: string
        thinkingConfig?: KinThinkingConfig
      } = { prompt: prompt.trim() }
      const trimmedTitle = title.trim()
      if (trimmedTitle) body.title = trimmedTitle
      if (selectedToolboxIds.length > 0) body.toolboxIds = selectedToolboxIds
      // model + providerId are coupled — send only when both are set.
      if (model && providerId) {
        body.model = model
        body.providerId = providerId
      }
      if (thinkingChoice !== 'inherit') {
        const cfg = choiceToConfig(thinkingChoice)
        if (cfg) body.thinkingConfig = cfg
      }
      await api.post(`/kins/${kinId}/tasks`, body)
      toast.success(t('orphanTask.started', { name: kinName }))
      onOpenChange(false)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('orphanTask.title')}</DialogTitle>
          <DialogDescription>{t('orphanTask.description', { name: kinName })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="orphan-task-prompt">{t('orphanTask.promptField')}</Label>
            <Textarea
              id="orphan-task-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value.slice(0, PROMPT_MAX))}
              placeholder={t('orphanTask.promptPlaceholder')}
              rows={4}
              maxLength={PROMPT_MAX}
            />
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs text-muted-foreground">{t('orphanTask.promptHelp')}</p>
              <p
                className={`text-xs tabular-nums ${promptOverLimit ? 'text-destructive' : 'text-muted-foreground'}`}
              >
                {t('orphanTask.promptCounter', { count: promptLength })}
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="orphan-task-title">{t('orphanTask.titleField')}</Label>
            <Input
              id="orphan-task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, TITLE_MAX))}
              placeholder={t('orphanTask.titlePlaceholder')}
              maxLength={TITLE_MAX}
            />
          </div>

          {toolboxes.length > 0 && (
            <div className="space-y-1.5">
              <Label>{t('orphanTask.toolboxesField')}</Label>
              <ToolboxMultiSelect
                toolboxes={toolboxes}
                selected={selectedToolboxIds}
                onChange={setSelectedToolboxIds}
                disabled={submitting}
              />
              <p className="text-xs text-muted-foreground">{t('orphanTask.toolboxesHelp')}</p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>{t('orphanTask.modelField')}</Label>
            <ModelPicker
              models={llmModels}
              value={modelPickerValue(model, providerId)}
              onValueChange={(modelId, pid) => {
                setModel(modelId)
                setProviderId(pid)
              }}
              placeholder={t('orphanTask.modelInherit')}
              clearLabel={t('orphanTask.modelInherit')}
              allowClear
              isLoading={modelsLoading}
              disabled={submitting}
            />
            <p className="text-xs text-muted-foreground">{t('orphanTask.modelHelp')}</p>
          </div>

          <div className="space-y-1.5">
            <Label>{t('orphanTask.thinkingField')}</Label>
            <ThinkingEffortSelect
              value={thinkingChoice}
              onChange={setThinkingChoice}
              inheritLabel={t('orphanTask.thinkingInherit')}
              disabled={submitting}
            />
            <p className="text-xs text-muted-foreground">{t('orphanTask.thinkingHelp')}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {t('orphanTask.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
