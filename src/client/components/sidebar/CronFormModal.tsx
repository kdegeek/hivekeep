import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/client/components/ui/input'
import { Button } from '@/client/components/ui/button'
import { ConfirmDeleteButton } from '@/client/components/common/ConfirmDeleteButton'
import { Label } from '@/client/components/ui/label'
import { FormDialog } from '@/client/components/common/FormDialog'
import { FormField } from '@/client/components/common/FormField'
import { MarkdownEditor } from '@/client/components/ui/markdown-editor'
import { ModelPicker, modelPickerValue } from '@/client/components/common/ModelPicker'
import { ToolboxMultiSelect } from '@/client/components/toolbox/ToolboxMultiSelect'
import { useToolboxes } from '@/client/hooks/useToolboxes'
import { AgentSelector } from '@/client/components/common/AgentSelector'
import { AgentSelectItem, type AgentOption } from '@/client/components/common/AgentSelectItem'
import type { AgentThinkingEffort } from '@/shared/types'
import { Switch } from '@/client/components/ui/switch'
import { Sparkles, Trash2, Bell, AlertTriangle } from 'lucide-react'
import { UnsavedChangesDialog } from '@/client/components/common/UnsavedChangesDialog'
import { useUnsavedChanges } from '@/client/hooks/useUnsavedChanges'
import { useAuth } from '@/client/hooks/useAuth'
import { cn } from '@/client/lib/utils'
import { getErrorMessage } from '@/client/lib/api'
import { cronToHuman, isISODatetime } from '@/client/lib/cron-human'
import { cronNextRuns } from '@/client/lib/cron-next'
import type { CronSummary } from '@/shared/types'
import type { ProviderModel } from '@/client/hooks/useModels'
import { modelReasoningInfo, clampEffort } from '@/client/lib/model-efforts'
import { ThinkingEffortSelect } from '@/client/components/common/ThinkingEffortSelect'
import type { ThinkingChoice } from '@/client/lib/thinking-choice'

interface CronFormModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agents: AgentOption[]
  llmModels: ProviderModel[]
  cron?: CronSummary | null
  /** Pre-fill values for create mode (used when duplicating). */
  defaults?: Partial<CronSummary> | null
  onCreate?: (data: {
    agentId: string
    name: string
    schedule: string
    taskDescription: string
    targetAgentId?: string
    model?: string
    providerId?: string
    runOnce?: boolean
    triggerParentTurn?: boolean
    thinkingEffort?: AgentThinkingEffort | null
    toolboxIds?: string[]
  }) => Promise<CronSummary>
  onUpdate?: (id: string, updates: Record<string, unknown>) => Promise<CronSummary>
  onDelete?: (id: string) => Promise<void>
}

const CRON_PRESETS = [
  { key: 'presetEvery5m', value: '*/5 * * * *' },
  { key: 'presetEvery15m', value: '*/15 * * * *' },
  { key: 'presetEvery30m', value: '*/30 * * * *' },
  { key: 'presetHourly', value: '0 * * * *' },
  { key: 'presetDaily9am', value: '0 9 * * *' },
  { key: 'presetDaily6pm', value: '0 18 * * *' },
  { key: 'presetWeekdayMorning', value: '0 9 * * 1-5' },
  { key: 'presetWeekly', value: '0 9 * * 1' },
  { key: 'presetMonthly', value: '0 9 1 * *' },
] as const

export function CronFormModal({
  open,
  onOpenChange,
  agents,
  llmModels,
  cron,
  defaults,
  onCreate,
  onUpdate,
  onDelete,
}: CronFormModalProps) {
  const { t, i18n } = useTranslation()
  const { user } = useAuth()
  const { toolboxes } = useToolboxes()
  const serverTimezone = user?.serverTimezone
  const isEdit = !!cron

  // Unsaved changes guard
  const { markDirty, resetDirty, guardedClose, confirmDialogProps } = useUnsavedChanges({
    onClose: () => onOpenChange(false),
  })

  const [name, setName] = useState('')
  const [agentId, setAgentId] = useState('')
  const [schedule, setSchedule] = useState('')
  const [runOnce, setRunOnce] = useState(false)
  const [triggerParentTurn, setTriggerParentTurn] = useState(false)
  const [scheduleDatetime, setScheduleDatetime] = useState('')
  const [taskDescription, setTaskDescription] = useState('')
  const [targetAgentId, setTargetAgentId] = useState<string>('')
  const [model, setModel] = useState('')
  const [modelProviderId, setModelProviderId] = useState('')
  const [thinkingEffort, setThinkingEffort] = useState<AgentThinkingEffort | 'off'>('medium')
  const [selectedToolboxIds, setSelectedToolboxIds] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Effort options follow the model override's registry metadata. No override →
  // the executing model is resolved server-side (target agent / defaults), so
  // offer the generic ladder and let the provider clamp at run time.
  const modelReasoning = useMemo(
    () => (model
      ? modelReasoningInfo(llmModels.find((m) => m.id === model && (!modelProviderId || m.providerId === modelProviderId)))
      : undefined),
    [model, modelProviderId, llmModels],
  )
  // Toggle-only models have no effort dial: an enabled cron shows as 'on'.
  const thinkingChoice: ThinkingChoice = thinkingEffort === 'off'
    ? 'off'
    : modelReasoning?.kind === 'toggle' ? 'on' : thinkingEffort
  const handleThinkingChoice = (v: ThinkingChoice) => {
    // 'on' (toggle-only) keeps a concrete effort in state — the provider
    // ignores granularity for those models; 'inherit' never offered here.
    if (v === 'off') setThinkingEffort('off')
    else if (v === 'on') setThinkingEffort('medium')
    else if (v !== 'inherit') setThinkingEffort(v)
    markDirty()
  }
  // Clamp a stale effort when the model override changes under it.
  useEffect(() => {
    if (!modelReasoning || thinkingEffort === 'off') return
    if (modelReasoning.kind === 'unsupported') { setThinkingEffort('off'); return }
    if (modelReasoning.kind === 'levels' && !modelReasoning.efforts.includes(thinkingEffort)) {
      const clamped = clampEffort(thinkingEffort, modelReasoning)
      if (clamped) setThinkingEffort(clamped)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelReasoning])

  // Populate form when editing or reset for create
  useEffect(() => {
    if (open) {
      if (cron) {
        setName(cron.name)
        setAgentId(cron.agentId)
        const isOneShot = cron.runOnce && isISODatetime(cron.schedule)
        setRunOnce(cron.runOnce ?? false)
        setTriggerParentTurn(cron.triggerParentTurn ?? false)
        if (isOneShot) {
          setScheduleDatetime(cron.schedule.slice(0, 16)) // trim to datetime-local format
          setSchedule('')
        } else {
          setSchedule(cron.schedule)
          setScheduleDatetime('')
        }
        setTaskDescription(cron.taskDescription)
        setTargetAgentId(cron.targetAgentId ?? '')
        setModel(cron.model ?? '')
        setModelProviderId(cron.providerId ?? '')
        setThinkingEffort(cron.thinkingEffort ?? (cron.thinkingEnabled ? 'medium' : 'off'))
        setSelectedToolboxIds(cron.toolboxIds ?? [])
      } else if (defaults) {
        setName(defaults.name ?? '')
        setAgentId(defaults.agentId ?? (agents.length === 1 ? agents[0]!.id : ''))
        setRunOnce(defaults.runOnce ?? false)
        setTriggerParentTurn(defaults.triggerParentTurn ?? false)
        setSchedule(defaults.schedule ?? '')
        setScheduleDatetime('')
        setTaskDescription(defaults.taskDescription ?? '')
        setTargetAgentId(defaults.targetAgentId ?? '')
        setModel(defaults.model ?? '')
        setModelProviderId(defaults.providerId ?? '')
        setThinkingEffort(defaults.thinkingEffort ?? (defaults.thinkingEnabled ? 'medium' : 'off'))
        setSelectedToolboxIds(defaults.toolboxIds ?? [])
      } else {
        setName('')
        setAgentId(agents.length === 1 ? agents[0]!.id : '')
        setRunOnce(false)
        setTriggerParentTurn(false)
        setSchedule('')
        setScheduleDatetime('')
        setTaskDescription('')
        setTargetAgentId('')
        setModel('')
        setModelProviderId('')
        setThinkingEffort('medium')
        setSelectedToolboxIds([])
      }
      setError(null)
      resetDirty()
    }
  }, [open, cron, defaults, agents, resetDirty])

  async function handleSubmit() {
    setError(null)
    setIsSubmitting(true)

    const effectiveSchedule = runOnce && scheduleDatetime ? scheduleDatetime : schedule

    const effortPayload: AgentThinkingEffort | null = thinkingEffort === 'off' ? null : thinkingEffort

    try {
      if (isEdit && onUpdate && cron) {
        await onUpdate(cron.id, {
          name,
          schedule: effectiveSchedule,
          taskDescription,
          targetAgentId: targetAgentId || null,
          model: model || null,
          providerId: modelProviderId || null,
          runOnce,
          triggerParentTurn,
          thinkingEffort: effortPayload,
          toolboxIds: selectedToolboxIds,
        })
      } else if (onCreate) {
        await onCreate({
          agentId,
          name,
          schedule: effectiveSchedule,
          taskDescription,
          targetAgentId: targetAgentId || undefined,
          model: model || undefined,
          providerId: modelProviderId || undefined,
          runOnce: runOnce || undefined,
          triggerParentTurn,
          thinkingEffort: effortPayload,
          toolboxIds: selectedToolboxIds.length > 0 ? selectedToolboxIds : undefined,
        })
      }
      resetDirty()
      onOpenChange(false)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleDelete() {
    if (!cron || !onDelete) return
    setIsSubmitting(true)
    try {
      await onDelete(cron.id)
      resetDirty()
      onOpenChange(false)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  const selectedAgent = agents.find((k) => k.id === agentId)
  const effectiveScheduleForDisplay = runOnce && scheduleDatetime ? scheduleDatetime : schedule
  const scheduleHuman = useMemo(() => cronToHuman(effectiveScheduleForDisplay, i18n.language), [effectiveScheduleForDisplay, i18n.language])
  const scheduleInvalid = useMemo(() => {
    if (runOnce && scheduleDatetime) {
      const d = new Date(scheduleDatetime)
      return isNaN(d.getTime()) || d <= new Date()
    }
    return schedule.trim().length > 0 && !scheduleHuman
  }, [runOnce, scheduleDatetime, schedule, scheduleHuman])
  const nextRuns = useMemo(() => {
    if (runOnce && scheduleDatetime) return [] // one-shot: no recurring runs to preview
    return scheduleHuman ? cronNextRuns(schedule, 3, serverTimezone) : []
  }, [runOnce, scheduleDatetime, schedule, scheduleHuman, serverTimezone])

  const submitDisabled =
    isSubmitting ||
    !name ||
    (runOnce ? !scheduleDatetime : !schedule) ||
    scheduleInvalid ||
    !taskDescription ||
    (!isEdit && !agentId)

  return (
    <>
      <FormDialog
        open={open}
        onOpenChange={(v) => { if (!v) guardedClose() }}
        title={isEdit ? t('cron.edit.title') : t('cron.create.title')}
        size="2xl"
        error={error}
        onSubmit={handleSubmit}
        isSubmitting={isSubmitting}
        submitDisabled={submitDisabled}
        submitLabel={isEdit ? t('cron.edit.save') : t('cron.create.submit')}
        footer={
          <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:items-center">
            {isEdit && onDelete && cron && (
              <ConfirmDeleteButton
                onConfirm={handleDelete}
                title={t('cron.edit.delete')}
                description={t('cron.edit.deleteConfirm')}
                confirmLabel={t('cron.edit.deleteAction')}
                trigger={
                  <Button type="button" variant="destructive" size="sm" className="sm:mr-auto">
                    <Trash2 className="mr-1.5 size-3.5" />
                    {t('cron.edit.delete')}
                  </Button>
                }
              />
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => guardedClose()}
              disabled={isSubmitting}
              className="sm:ml-auto"
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={submitDisabled}
              className="btn-shine"
            >
              {isEdit ? t('cron.edit.save') : t('cron.create.submit')}
            </Button>
          </div>
        }
      >
        {/* Name */}
        <FormField
          label={t('cron.create.name')}
          htmlFor="cronFormName"
          tip={t('cron.create.nameTip')}
          required
        >
          <Input
            id="cronFormName"
            value={name}
            onChange={(e) => { setName(e.target.value); markDirty() }}
            placeholder={t('cron.create.namePlaceholder')}
            required
          />
        </FormField>

        {/* Owner Agent */}
        <FormField label={t('cron.create.agent')} tip={t('cron.create.agentTip')}>
          {isEdit ? (
            <div className="flex items-center gap-2.5 rounded-md border border-input bg-muted/30 px-3 py-2">
              {selectedAgent && <AgentSelectItem agent={selectedAgent} />}
            </div>
          ) : (
            <AgentSelector
              value={agentId}
              onValueChange={setAgentId}
              agents={agents}
              placeholder={t('cron.create.agentPlaceholder')}
              required
            />
          )}
        </FormField>

        {/* Schedule type toggle */}
        <FormField label={t('cron.create.scheduleType', 'Schedule type')}>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => { setRunOnce(false); markDirty() }}
              className={cn(
                'rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                !runOnce
                  ? 'border-primary/50 bg-primary/10 text-primary'
                  : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              {t('cron.create.recurring', 'Recurring')}
            </button>
            <button
              type="button"
              onClick={() => { setRunOnce(true); markDirty() }}
              className={cn(
                'rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                runOnce
                  ? 'border-primary/50 bg-primary/10 text-primary'
                  : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              {t('cron.create.oneTime', 'One-time')}
            </button>
          </div>
        </FormField>

        {/* Schedule */}
        {runOnce ? (
          <FormField
            label={t('cron.create.schedule')}
            htmlFor="cronFormSchedule"
            tip={t('cron.create.scheduleTip')}
            required
            hint={t('cron.create.oneTimeHelp', 'Pick a date and time. The cron will fire once and then deactivate.')}
            error={
              scheduleInvalid && scheduleDatetime
                ? t('cron.create.datetimePast', 'Datetime must be in the future')
                : undefined
            }
          >
            <Input
              id="cronFormSchedule"
              type="datetime-local"
              value={scheduleDatetime}
              onChange={(e) => { setScheduleDatetime(e.target.value); markDirty() }}
              className={cn(scheduleInvalid && 'border-destructive focus-visible:ring-destructive/30')}
              required
            />
            {scheduleDatetime && !scheduleInvalid && scheduleHuman && (
              <p className="text-[11px] text-primary/80 italic">
                {scheduleHuman} ({t('cron.create.serverTime')})
              </p>
            )}
          </FormField>
        ) : (
          <FormField
            label={t('cron.create.schedule')}
            htmlFor="cronFormSchedule"
            tip={t('cron.create.scheduleTip')}
            required
            hint={t('cron.create.scheduleHelp')}
            error={scheduleInvalid ? t('cron.create.scheduleInvalid') : undefined}
          >
            <Input
              id="cronFormSchedule"
              value={schedule}
              onChange={(e) => { setSchedule(e.target.value); markDirty() }}
              placeholder={t('cron.create.schedulePlaceholder')}
              className={cn('font-mono', scheduleInvalid && 'border-destructive focus-visible:ring-destructive/30')}
              required
            />
            <div className="flex flex-wrap gap-1.5">
              {CRON_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  onClick={() => { setSchedule(preset.value); markDirty() }}
                  className={cn(
                    'rounded-md border px-2 py-0.5 text-[11px] transition-colors',
                    schedule === preset.value
                      ? 'border-primary/50 bg-primary/10 text-primary'
                      : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  {t(`cron.create.${preset.key}`)}
                </button>
              ))}
            </div>
            {scheduleHuman && (
              <div className="space-y-0.5">
                <p className="text-[11px] text-primary/80 italic">
                  {scheduleHuman} ({t('cron.create.serverTime')})
                </p>
                {nextRuns.length > 0 && (
                  <p className="text-[11px] text-muted-foreground">
                    {t('cron.create.nextRuns')}: {nextRuns.map((d) =>
                      d.toLocaleString(i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
                    ).join(', ')}
                  </p>
                )}
              </div>
            )}
          </FormField>
        )}

        {/* Task description (MarkdownEditor) */}
        <FormField label={t('cron.create.taskDescription')} tip={t('cron.create.taskDescriptionTip')}>
          <MarkdownEditor
            value={taskDescription}
            onChange={(v) => { setTaskDescription(v); markDirty() }}
            height="160px"
          />
        </FormField>

        {/* Target Agent (optional) */}
        <FormField
          label={t('cron.create.targetAgent')}
          tip={t('cron.create.targetAgentTip')}
          hint={t('cron.create.targetAgentHint')}
        >
          <AgentSelector
            value={targetAgentId}
            onValueChange={setTargetAgentId}
            agents={agents}
            placeholder="—"
            noneLabel="—"
          />
        </FormField>

        {/* Model (ModelPicker) */}
        <FormField label={t('cron.create.model')} tip={t('cron.create.modelTip')}>
          <ModelPicker
            models={llmModels}
            value={modelPickerValue(model, modelProviderId)}
            onValueChange={(modelId, pid) => { setModel(modelId); setModelProviderId(pid) }}
            placeholder={t('cron.create.modelPlaceholder')}
            allowClear
          />
        </FormField>

        {/* Thinking effort */}
        <FormField
          label={
            <>
              <Sparkles className="size-3.5" />
              {t('chat.thinkingPicker.title')}
            </>
          }
        >
          <ThinkingEffortSelect
            value={thinkingChoice}
            onChange={handleThinkingChoice}
            reasoning={modelReasoning}
          />
        </FormField>

        {/* Toolboxes */}
        {toolboxes.length > 0 && (
          <FormField
            label={t('cron.create.toolboxes')}
            tip={t('cron.create.toolboxesTip')}
            hint={t('cron.create.toolboxesHelp')}
          >
            <ToolboxMultiSelect
              toolboxes={toolboxes}
              selected={selectedToolboxIds}
              onChange={(next) => { setSelectedToolboxIds(next); markDirty() }}
              disabled={isSubmitting}
            />
          </FormField>
        )}

        {/* Trigger parent turn */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 rounded-md border border-input bg-muted/30 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <Label htmlFor="cronTriggerParentTurn" className="inline-flex items-center gap-1.5 cursor-pointer">
                <Bell className="size-3.5" />
                {t('cron.triggerParentTurn.label')}
              </Label>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{t('cron.triggerParentTurn.help')}</p>
            </div>
            <Switch
              id="cronTriggerParentTurn"
              checked={triggerParentTurn}
              onCheckedChange={(v) => { setTriggerParentTurn(v); markDirty() }}
              className="shrink-0"
            />
          </div>
          {triggerParentTurn && (
            <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{t('cron.triggerParentTurn.warning')}</span>
            </div>
          )}
        </div>
      </FormDialog>

      {/* Unsaved changes confirmation */}
      <UnsavedChangesDialog {...confirmDialogProps} />
    </>
  )
}
