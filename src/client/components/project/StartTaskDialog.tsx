import { useEffect, useRef, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { api, getErrorMessage } from '@/client/lib/api'
import { FormDialog } from '@/client/components/common/FormDialog'
import { FormField } from '@/client/components/common/FormField'
import { Textarea } from '@/client/components/ui/textarea'
import { AgentSelector } from '@/client/components/common/AgentSelector'
import { ToolboxMultiSelect } from '@/client/components/toolbox/ToolboxMultiSelect'
import { ModelPicker, modelPickerValue } from '@/client/components/common/ModelPicker'
import { ThinkingEffortSelect } from '@/client/components/common/ThinkingEffortSelect'
import { modelReasoningInfo, clampEffort } from '@/client/lib/model-efforts'
import { useTickets } from '@/client/hooks/useTickets'
import { useToolboxes } from '@/client/hooks/useToolboxes'
import { useModels } from '@/client/hooks/useModels'
import { choiceToConfig, type ThinkingChoice } from '@/client/lib/thinking-choice'
import { toast } from 'sonner'

interface AgentFromApi {
  id: string
  name: string
  role?: string
  avatarUrl: string | null
  activeProjectId: string | null
}

interface StartTaskDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  ticketId: string
  projectId: string
}

const RUN_PROMPT_MAX = 500

export function StartTaskDialog({ open, onOpenChange, ticketId, projectId }: StartTaskDialogProps) {
  const { t } = useTranslation()
  const { startTicketTask } = useTickets(projectId)
  const { toolboxes } = useToolboxes()
  const { llmModels, isLoading: modelsLoading } = useModels()
  const [agents, setAgents] = useState<AgentFromApi[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string>('')
  const [runPrompt, setRunPrompt] = useState('')
  const [selectedToolboxIds, setSelectedToolboxIds] = useState<string[]>([])
  // Model + effort overrides. Both default to "inherit" (empty model / 'inherit'
  // choice) so an unset picker changes nothing — resolution falls back to the
  // project default, then the Agent.
  const [model, setModel] = useState('')
  const [providerId, setProviderId] = useState('')
  const [thinkingChoice, setThinkingChoice] = useState<ThinkingChoice>('inherit')
  const [submitting, setSubmitting] = useState(false)

  // Effort options follow the model override's registry metadata; no override →
  // generic ladder (the executing model is resolved server-side at spawn).
  const modelReasoning = useMemo(
    () => (model
      ? modelReasoningInfo(llmModels.find((m) => m.id === model && (!providerId || m.providerId === providerId)))
      : undefined),
    [model, providerId, llmModels],
  )
  // Clamp a stale choice when the model override changes under it.
  useEffect(() => {
    if (!modelReasoning || thinkingChoice === 'inherit' || thinkingChoice === 'off') return
    if (modelReasoning.kind === 'unsupported') { setThinkingChoice('off'); return }
    if (modelReasoning.kind === 'toggle') { setThinkingChoice('on'); return }
    if (modelReasoning.kind === 'levels') {
      if (thinkingChoice === 'on') { setThinkingChoice('medium'); return }
      if (!modelReasoning.efforts.includes(thinkingChoice)) {
        const clamped = clampEffort(thinkingChoice, modelReasoning)
        if (clamped) setThinkingChoice(clamped)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelReasoning])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    api
      .get<{ agents: AgentFromApi[] }>('/agents')
      .then((data) => {
        if (cancelled) return
        setAgents(data.agents)
        // Pre-select first Agent that has this project as active
        const match = data.agents.find((k) => k.activeProjectId === projectId)
        setSelectedAgentId(match?.id ?? data.agents[0]?.id ?? '')
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [open, projectId])

  // Reset the sur-prompt whenever the dialog reopens so a previous draft does
  // not leak into a fresh task spawn.
  useEffect(() => {
    if (!open) setRunPrompt('')
  }, [open])

  // Default the toolbox selection to the 'code' built-in for ticket tasks
  // (mirrors the legacy preset default). Applied exactly once per open session
  // — guarded by a ref so deselecting every toolbox is respected and never
  // re-seeded behind the user's back.
  const defaultAppliedRef = useRef(false)
  useEffect(() => {
    if (!open) {
      setSelectedToolboxIds([])
      setModel('')
      setProviderId('')
      setThinkingChoice('inherit')
      defaultAppliedRef.current = false
      return
    }
    if (defaultAppliedRef.current) return
    const code = toolboxes.find((tb) => tb.builtin && tb.name === 'code')
    if (code) {
      setSelectedToolboxIds([code.id])
      defaultAppliedRef.current = true
    }
  }, [open, toolboxes])

  async function handleSubmit() {
    if (!selectedAgentId) return
    setSubmitting(true)
    try {
      // model + providerId are coupled — send only when both are set.
      const modelOverride = model && providerId ? model : undefined
      const providerOverride = model && providerId ? providerId : undefined
      // 'inherit' → undefined (no override); everything else maps to a config.
      const thinkingOverride =
        thinkingChoice === 'inherit' ? undefined : (choiceToConfig(thinkingChoice) ?? undefined)
      await startTicketTask(
        ticketId,
        selectedAgentId,
        runPrompt.trim() || undefined,
        selectedToolboxIds.length > 0 ? selectedToolboxIds : undefined,
        modelOverride,
        providerOverride,
        thinkingOverride,
      )
      onOpenChange(false)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  // Sort agents so the project-active one (if any) appears first
  const sortedAgents = [...agents].sort((a, b) => {
    const aActive = a.activeProjectId === projectId ? 1 : 0
    const bActive = b.activeProjectId === projectId ? 1 : 0
    return bActive - aActive
  })

  // AgentSelector expects AgentOption[] — our API shape is already compatible (id/name/role/avatarUrl)
  const agentOptions = sortedAgents.map((k) => ({
    id: k.id,
    name: k.activeProjectId === projectId ? `${k.name} · ${t('projects.startTask.activeOnProject')}` : k.name,
    role: k.role,
    avatarUrl: k.avatarUrl,
  }))

  const runPromptLength = runPrompt.length
  const runPromptOverLimit = runPromptLength > RUN_PROMPT_MAX

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('projects.startTask.title')}
      description={t('projects.startTask.description')}
      size="lg"
      onSubmit={handleSubmit}
      isSubmitting={submitting}
      submitDisabled={!selectedAgentId || runPromptOverLimit}
      submitLabel={t('projects.startTask.start')}
    >
      <FormField label={t('projects.startTask.agentField')}>
        <AgentSelector
          value={selectedAgentId}
          onValueChange={setSelectedAgentId}
          agents={agentOptions}
          placeholder={t('projects.startTask.agentPlaceholder')}
        />
      </FormField>

      <FormField
        label={t('projects.startTask.runPromptField')}
        htmlFor="start-task-run-prompt"
        hint={
          <span className="flex items-start justify-between gap-2">
            <span>{t('projects.startTask.runPromptHelp')}</span>
            <span className={`tabular-nums ${runPromptOverLimit ? 'text-destructive' : 'text-muted-foreground'}`}>
              {t('projects.startTask.runPromptCounter', { count: runPromptLength })}
            </span>
          </span>
        }
      >
        <Textarea
          id="start-task-run-prompt"
          value={runPrompt}
          onChange={(e) => setRunPrompt(e.target.value.slice(0, RUN_PROMPT_MAX))}
          placeholder={t('projects.startTask.runPromptPlaceholder')}
          rows={3}
          maxLength={RUN_PROMPT_MAX}
        />
      </FormField>

      {toolboxes.length > 0 && (
        <FormField
          label={t('projects.startTask.toolboxesField')}
          hint={t('projects.startTask.toolboxesHelp')}
        >
          <ToolboxMultiSelect
            toolboxes={toolboxes}
            selected={selectedToolboxIds}
            onChange={setSelectedToolboxIds}
            disabled={submitting}
          />
        </FormField>
      )}

      <FormField
        label={t('projects.startTask.modelField')}
        hint={t('projects.startTask.modelHelp')}
      >
        <ModelPicker
          models={llmModels}
          value={modelPickerValue(model, providerId)}
          onValueChange={(modelId, pid) => {
            setModel(modelId)
            setProviderId(pid)
          }}
          placeholder={t('projects.startTask.modelInherit')}
          clearLabel={t('projects.startTask.modelInherit')}
          allowClear
          isLoading={modelsLoading}
          disabled={submitting}
        />
      </FormField>

      <FormField
        label={t('projects.startTask.thinkingField')}
        hint={t('projects.startTask.thinkingHelp')}
      >
        <ThinkingEffortSelect
          value={thinkingChoice}
          reasoning={modelReasoning}
          onChange={setThinkingChoice}
          inheritLabel={t('projects.startTask.thinkingInherit')}
          disabled={submitting}
        />
      </FormField>
    </FormDialog>
  )
}
