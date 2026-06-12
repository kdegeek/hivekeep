import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import { Label } from '@/client/components/ui/label'
import { Switch } from '@/client/components/ui/switch'
import { Badge } from '@/client/components/ui/badge'
import { Textarea } from '@/client/components/ui/textarea'
import { FormDialog } from '@/client/components/common/FormDialog'
import { FormField } from '@/client/components/common/FormField'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/client/components/ui/collapsible'
import { AgentSelector } from '@/client/components/common/AgentSelector'
import type { AgentOption } from '@/client/components/common/AgentSelectItem'
import { Loader2, ChevronDown, Filter, X, Check, CircleX, FlaskConical, MessageSquare, ListTodo } from 'lucide-react'
import type { WebhookSummary, WebhookFilterMode, WebhookDispatchMode, WebhookFilterTestResult } from '@/shared/types'
import { api } from '@/client/lib/api'

interface WebhookFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (agentId: string, data: {
    name: string
    description?: string
    dispatchMode?: WebhookDispatchMode
    taskTitleTemplate?: string | null
    taskPromptTemplate?: string | null
    maxConcurrentTasks?: number
  }) => Promise<void>
  onUpdate?: (webhookId: string, data: {
    name?: string
    description?: string | null
    isActive?: boolean
    filterMode?: WebhookFilterMode | null
    filterField?: string | null
    filterAllowedValues?: string[] | null
    filterExpression?: string | null
    dispatchMode?: WebhookDispatchMode
    taskTitleTemplate?: string | null
    taskPromptTemplate?: string | null
    maxConcurrentTasks?: number
  }) => Promise<void>
  webhook?: WebhookSummary | null
  agents: AgentOption[]
}

export function WebhookFormDialog({
  open,
  onOpenChange,
  onSave,
  onUpdate,
  webhook,
  agents,
}: WebhookFormDialogProps) {
  const { t } = useTranslation()
  const isEdit = !!webhook

  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Dispatch mode state
  const [dispatchMode, setDispatchMode] = useState<WebhookDispatchMode>('conversation')
  const [taskTitleTemplate, setTaskTitleTemplate] = useState('')
  const [taskPromptTemplate, setTaskPromptTemplate] = useState('')
  const [maxConcurrentTasks, setMaxConcurrentTasks] = useState(1)

  // Filter state
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterMode, setFilterMode] = useState<WebhookFilterMode | null>(null)
  const [filterField, setFilterField] = useState('')
  const [filterAllowedValues, setFilterAllowedValues] = useState<string[]>([])
  const [filterExpression, setFilterExpression] = useState('')
  const [suggestedFields, setSuggestedFields] = useState<string[]>([])
  const [allowedValueInput, setAllowedValueInput] = useState('')

  // Test state
  const [testPayload, setTestPayload] = useState('')
  const [testResult, setTestResult] = useState<WebhookFilterTestResult | null>(null)
  const [testLoading, setTestLoading] = useState(false)

  // Last payload for template preview
  const [lastPayload, setLastPayload] = useState<string | null>(null)

  // Regex validation
  const [regexError, setRegexError] = useState<string | null>(null)

  useEffect(() => {
    if (webhook) {
      setName(webhook.name)
      setDescription(webhook.description ?? '')
      setIsActive(webhook.isActive)
      setSelectedAgentId(webhook.agentId)
      setFilterMode(webhook.filterMode)
      setFilterField(webhook.filterField ?? '')
      setFilterAllowedValues(webhook.filterAllowedValues ?? [])
      setFilterExpression(webhook.filterExpression ?? '')
      setFilterOpen(!!webhook.filterMode)
      setDispatchMode(webhook.dispatchMode ?? 'conversation')
      setTaskTitleTemplate(webhook.taskTitleTemplate ?? '')
      setTaskPromptTemplate(webhook.taskPromptTemplate ?? '')
      setMaxConcurrentTasks(webhook.maxConcurrentTasks ?? 1)
    } else {
      setName('')
      setDescription('')
      setIsActive(true)
      setSelectedAgentId('')
      setFilterMode(null)
      setFilterField('')
      setFilterAllowedValues([])
      setFilterExpression('')
      setFilterOpen(false)
      setDispatchMode('conversation')
      setTaskTitleTemplate('')
      setTaskPromptTemplate('')
      setMaxConcurrentTasks(1)
    }
    setError(null)
    setTestResult(null)
    setTestPayload('')
    setLastPayload(null)
    setSuggestedFields([])
    setAllowedValueInput('')
    setRegexError(null)
  }, [webhook, open])

  // Fetch suggested fields when opening edit mode
  const fetchSuggestions = useCallback(async () => {
    if (!webhook?.id) return
    try {
      const data = await api.post<{ fields: string[]; lastPayload: string | null }>(
        `/webhooks/${webhook.id}/suggest-fields`,
      )
      setSuggestedFields(data.fields)
      setLastPayload(data.lastPayload)
      if (data.lastPayload && !testPayload) {
        // Pretty-print JSON for readability and to prevent horizontal overflow
        let formatted = data.lastPayload
        try {
          formatted = JSON.stringify(JSON.parse(data.lastPayload), null, 2)
        } catch {
          // Not valid JSON — use as-is
        }
        setTestPayload(formatted)
      }
    } catch {
      // Ignore — suggestions are optional
    }
  }, [webhook?.id])

  useEffect(() => {
    if (open && isEdit) {
      fetchSuggestions()
    }
  }, [open, isEdit, fetchSuggestions])

  // Validate regex on change
  useEffect(() => {
    if (filterMode !== 'advanced' || !filterExpression) {
      setRegexError(null)
      return
    }
    try {
      new RegExp(filterExpression)
      setRegexError(null)
    } catch {
      setRegexError(t('settings.webhooks.filterExpressionInvalid'))
    }
  }, [filterExpression, filterMode, t])

  const handleSubmit = async () => {
    setIsLoading(true)
    setError(null)

    try {
      if (isEdit && onUpdate && webhook) {
        await onUpdate(webhook.id, {
          name,
          description: description || null,
          isActive,
          filterMode,
          filterField: filterMode === 'simple' ? filterField || null : null,
          filterAllowedValues: filterMode === 'simple' ? filterAllowedValues : null,
          filterExpression: filterMode === 'advanced' ? filterExpression || null : null,
          dispatchMode,
          taskTitleTemplate: dispatchMode === 'task' ? taskTitleTemplate || null : null,
          taskPromptTemplate: dispatchMode === 'task' ? taskPromptTemplate || null : null,
          maxConcurrentTasks: dispatchMode === 'task' ? maxConcurrentTasks : 1,
        })
      } else {
        const targetAgentId = selectedAgentId
        if (!targetAgentId) return
        await onSave(targetAgentId, {
          name,
          description: description || undefined,
          dispatchMode,
          taskTitleTemplate: dispatchMode === 'task' ? taskTitleTemplate || null : null,
          taskPromptTemplate: dispatchMode === 'task' ? taskPromptTemplate || null : null,
          maxConcurrentTasks: dispatchMode === 'task' ? maxConcurrentTasks : 1,
        })
      }
      onOpenChange(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unexpected error occurred'
      setError(message)
    } finally {
      setIsLoading(false)
    }
  }

  const handleAddAllowedValue = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',') && allowedValueInput.trim()) {
      e.preventDefault()
      const value = allowedValueInput.trim().replace(/,$/, '')
      if (value && !filterAllowedValues.includes(value)) {
        setFilterAllowedValues([...filterAllowedValues, value])
      }
      setAllowedValueInput('')
    }
  }

  const handleRemoveAllowedValue = (value: string) => {
    setFilterAllowedValues(filterAllowedValues.filter((v) => v !== value))
  }

  const handleTestFilter = async () => {
    if (!webhook?.id || !testPayload) return
    setTestLoading(true)
    setTestResult(null)
    try {
      const result = await api.post<WebhookFilterTestResult>(
        `/webhooks/${webhook.id}/test-filter`,
        {
          payload: testPayload,
          filterMode,
          filterField: filterMode === 'simple' ? filterField || null : null,
          filterAllowedValues: filterMode === 'simple' ? filterAllowedValues : null,
          filterExpression: filterMode === 'advanced' ? filterExpression || null : null,
        },
      )
      setTestResult(result)
    } catch {
      setTestResult({ passed: false, error: 'request-failed' })
    } finally {
      setTestLoading(false)
    }
  }

  const handleFieldSuggestionClick = (field: string) => {
    setFilterField(field)
  }

  // Client-side template preview
  const resolvePreview = useCallback((template: string, payload: string): string => {
    let parsed: Record<string, unknown> | null = null
    try { parsed = JSON.parse(payload) } catch { /* non-JSON */ }

    return template.replace(/\{\{(.+?)\}\}/g, (_match, path: string) => {
      const trimmed = path.trim()
      if (trimmed === '__payload__') return payload
      if (!parsed) return ''
      const parts = trimmed.split('.')
      let current: unknown = parsed
      for (const part of parts) {
        if (current == null || typeof current !== 'object') return ''
        current = (current as Record<string, unknown>)[part]
      }
      if (current == null) return ''
      if (typeof current === 'object') {
        try { return JSON.stringify(current) } catch { return '' }
      }
      return String(current)
    })
  }, [])

  const canSubmit = !!(name.trim() && (isEdit || selectedAgentId))

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? t('settings.webhooks.edit') : t('settings.webhooks.add')}
      size="2xl"
      error={error}
      onSubmit={handleSubmit}
      isSubmitting={isLoading}
      submitDisabled={!canSubmit}
      submitLabel={t('common.save')}
    >
      {/* Agent selector (only for create) */}
      {!isEdit && (
        <FormField label={t('settings.webhooks.agent')}>
          <AgentSelector
            value={selectedAgentId}
            onValueChange={setSelectedAgentId}
            agents={agents}
            placeholder={t('settings.webhooks.agentPlaceholder')}
          />
        </FormField>
      )}

      {/* Name */}
      <FormField
        label={t('settings.webhooks.name')}
        htmlFor="webhook-name"
        tip={t('settings.webhooks.nameTip')}
      >
        <Input
          id="webhook-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('settings.webhooks.namePlaceholder')}
          required
        />
      </FormField>

      {/* Description */}
      <FormField
        label={t('settings.webhooks.descriptionLabel')}
        htmlFor="webhook-description"
        tip={t('settings.webhooks.descriptionTip')}
      >
        <Input
          id="webhook-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('settings.webhooks.descriptionPlaceholder')}
        />
      </FormField>

      {/* Active toggle (edit only) */}
      {isEdit && (
        <div className="flex items-center justify-between">
          <Label>{t('settings.webhooks.active')}</Label>
          <Switch checked={isActive} onCheckedChange={setIsActive} />
        </div>
      )}

      {/* Dispatch mode */}
      <FormField
        label={t('settings.webhooks.dispatchMode')}
        tip={t('settings.webhooks.dispatchModeTip')}
      >
        <div className="flex flex-wrap gap-1">
          {(['conversation', 'task'] as const).map((mode) => (
            <Button
              key={mode}
              type="button"
              variant={dispatchMode === mode ? 'default' : 'outline'}
              size="sm"
              onClick={() => setDispatchMode(mode)}
              className="gap-1.5"
            >
              {mode === 'conversation' && <MessageSquare className="size-3.5" />}
              {mode === 'task' && <ListTodo className="size-3.5" />}
              {t(`settings.webhooks.dispatchMode${mode === 'conversation' ? 'Conversation' : 'Task'}`)}
            </Button>
          ))}
        </div>
      </FormField>

      {/* Task mode fields */}
      {dispatchMode === 'task' && (
        <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
          <FormField
            label={t('settings.webhooks.taskTitleTemplate')}
            htmlFor="webhook-task-title"
            tip={t('settings.webhooks.taskTitleTemplateTip')}
          >
            <Input
              id="webhook-task-title"
              value={taskTitleTemplate}
              onChange={(e) => setTaskTitleTemplate(e.target.value)}
              placeholder={t('settings.webhooks.taskTitleTemplatePlaceholder')}
              className="font-mono text-sm"
            />
          </FormField>

          <FormField
            label={t('settings.webhooks.taskPromptTemplate')}
            htmlFor="webhook-task-prompt"
            tip={t('settings.webhooks.taskPromptTemplateTip')}
          >
            <Textarea
              id="webhook-task-prompt"
              value={taskPromptTemplate}
              onChange={(e) => setTaskPromptTemplate(e.target.value)}
              placeholder={t('settings.webhooks.taskPromptTemplatePlaceholder')}
              rows={5}
              className="font-mono text-xs max-h-[300px] overflow-y-auto resize-y [overflow-wrap:break-word] [word-break:break-all]"
            />
          </FormField>

          <FormField
            label={t('settings.webhooks.maxConcurrentTasks')}
            htmlFor="webhook-max-concurrent"
            tip={t('settings.webhooks.maxConcurrentTasksTip')}
          >
            <Input
              id="webhook-max-concurrent"
              type="number"
              min={0}
              value={maxConcurrentTasks}
              onChange={(e) => setMaxConcurrentTasks(Math.max(0, parseInt(e.target.value) || 0))}
              className="w-24"
            />
          </FormField>

          {/* Template preview */}
          {lastPayload && (taskTitleTemplate || taskPromptTemplate) && (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">{t('settings.webhooks.templatePreview')}</Label>
              {taskTitleTemplate && (
                <div className="rounded-md bg-muted/50 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">{t('settings.webhooks.taskTitleTemplate')}</p>
                  <p className="text-sm font-medium truncate">{resolvePreview(taskTitleTemplate, lastPayload)}</p>
                </div>
              )}
              {taskPromptTemplate && (
                <div className="rounded-md bg-muted/50 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">{t('settings.webhooks.taskPromptTemplate')}</p>
                  <pre className="text-xs whitespace-pre-wrap break-words max-h-32 overflow-y-auto">{resolvePreview(taskPromptTemplate, lastPayload)}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Filter section (edit only) */}
      {isEdit && (
        <Collapsible open={filterOpen} onOpenChange={setFilterOpen}>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium"
            >
              <span className="inline-flex items-center gap-2">
                <Filter className="size-4" />
                {t('settings.webhooks.filteringOptional')}
                {filterMode && (
                  <Badge variant="secondary" size="xs">
                    {filterMode === 'simple' ? t('settings.webhooks.filterModeSimple') : t('settings.webhooks.filterModeAdvanced')}
                  </Badge>
                )}
              </span>
              <ChevronDown className={`size-4 transition-transform ${filterOpen ? 'rotate-180' : ''}`} />
            </Button>
          </CollapsibleTrigger>

          <CollapsibleContent className="space-y-4 pt-2">
            {/* Mode selector */}
            <FormField label={t('settings.webhooks.filterMode')}>
              <div className="flex flex-wrap gap-1">
                {([null, 'simple', 'advanced'] as const).map((mode) => (
                  <Button
                    key={mode ?? 'none'}
                    type="button"
                    variant={filterMode === mode ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => {
                      setFilterMode(mode)
                      setTestResult(null)
                    }}
                  >
                    {mode === null && t('settings.webhooks.filterModeNone')}
                    {mode === 'simple' && t('settings.webhooks.filterModeSimple')}
                    {mode === 'advanced' && t('settings.webhooks.filterModeAdvanced')}
                  </Button>
                ))}
              </div>
            </FormField>

            {/* Simple mode fields */}
            {filterMode === 'simple' && (
              <>
                <FormField
                  label={t('settings.webhooks.filterField')}
                  htmlFor="webhook-filter-field"
                  tip={t('settings.webhooks.filterFieldTip')}
                >
                  <Input
                    id="webhook-filter-field"
                    value={filterField}
                    onChange={(e) => setFilterField(e.target.value)}
                    placeholder={t('settings.webhooks.filterFieldPlaceholder')}
                    list="filter-field-suggestions"
                  />
                  {suggestedFields.length > 0 && (
                    <datalist id="filter-field-suggestions">
                      {suggestedFields.map((f) => (
                        <option key={f} value={f} />
                      ))}
                    </datalist>
                  )}
                  {suggestedFields.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {suggestedFields.slice(0, 15).map((f) => (
                        <button
                          key={f}
                          type="button"
                          className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                          onClick={() => handleFieldSuggestionClick(f)}
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                  )}
                </FormField>

                <FormField
                  label={t('settings.webhooks.filterAllowedValues')}
                  htmlFor="webhook-allowed-value-input"
                  tip={t('settings.webhooks.filterAllowedValuesTip')}
                >
                  <div className="flex flex-wrap gap-1.5 min-h-[28px]">
                    {filterAllowedValues.map((value) => (
                      <Badge key={value} variant="secondary" className="gap-1">
                        {value}
                        <button
                          type="button"
                          onClick={() => handleRemoveAllowedValue(value)}
                          className="ml-0.5 rounded-full hover:bg-foreground/10"
                        >
                          <X className="size-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                  <Input
                    id="webhook-allowed-value-input"
                    value={allowedValueInput}
                    onChange={(e) => setAllowedValueInput(e.target.value)}
                    onKeyDown={handleAddAllowedValue}
                    placeholder={t('settings.webhooks.filterAllowedValuesPlaceholder')}
                  />
                  {filterAllowedValues.length === 0 && filterField && (
                    <p className="text-xs text-amber-500">
                      {t('settings.webhooks.filterAllowedValuesEmpty')}
                    </p>
                  )}
                </FormField>
              </>
            )}

            {/* Advanced mode fields */}
            {filterMode === 'advanced' && (
              <FormField
                label={t('settings.webhooks.filterExpression')}
                htmlFor="webhook-filter-expression"
                tip={t('settings.webhooks.filterExpressionTip')}
                error={regexError}
              >
                <Input
                  id="webhook-filter-expression"
                  value={filterExpression}
                  onChange={(e) => setFilterExpression(e.target.value)}
                  placeholder={t('settings.webhooks.filterExpressionPlaceholder')}
                  className={regexError ? 'border-destructive' : ''}
                />
              </FormField>
            )}

            {/* Test zone */}
            {filterMode && (
              <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3 overflow-hidden">
                <Label className="inline-flex items-center gap-1.5 text-sm font-medium">
                  <FlaskConical className="size-4" />
                  {t('settings.webhooks.filterTest')}
                </Label>
                <Textarea
                  value={testPayload}
                  onChange={(e) => {
                    setTestPayload(e.target.value)
                    setTestResult(null)
                  }}
                  placeholder={t('settings.webhooks.filterTestPayloadPlaceholder')}
                  rows={6}
                  className="font-mono text-xs max-h-[300px] overflow-y-auto resize-y [overflow-wrap:break-word] [word-break:break-all]"
                />
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleTestFilter}
                    disabled={testLoading || !testPayload}
                  >
                    {testLoading ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      t('settings.webhooks.filterTestRun')
                    )}
                  </Button>
                  {testResult && (
                    <div className="flex items-center gap-2 text-sm">
                      {testResult.passed ? (
                        <>
                          <Check className="size-4 text-emerald-500" />
                          <span className="text-emerald-500">{t('settings.webhooks.filterTestPassed')}</span>
                        </>
                      ) : (
                        <>
                          <CircleX className="size-4 text-destructive" />
                          <span className="text-destructive">{t('settings.webhooks.filterTestFiltered')}</span>
                        </>
                      )}
                    </div>
                  )}
                </div>
                {testResult && testResult.extractedValue !== undefined && (
                  <p className="text-xs text-muted-foreground">
                    {t('settings.webhooks.filterTestExtracted')}: <code className="rounded bg-muted px-1 py-0.5">{testResult.extractedValue ?? 'null'}</code>
                  </p>
                )}
                {testResult?.error && (
                  <p className="text-xs text-amber-500">
                    {t('settings.webhooks.filterTestError')}: {testResult.error}
                  </p>
                )}
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>
      )}
    </FormDialog>
  )
}
