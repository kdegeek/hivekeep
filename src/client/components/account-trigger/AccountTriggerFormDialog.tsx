import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder, AlertTriangle } from 'lucide-react'
import { FormDialog } from '@/client/components/common/FormDialog'
import { FormField } from '@/client/components/common/FormField'
import { Input } from '@/client/components/ui/input'
import { MarkdownEditor } from '@/client/components/ui/markdown-editor'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/client/components/ui/select'
import { AgentSelector } from '@/client/components/common/AgentSelector'
import type { AgentOption } from '@/client/components/common/AgentSelectItem'
import { api, getErrorMessage } from '@/client/lib/api'
import { useAgents } from '@/client/hooks/useAgents'
import { ConditionNodeEditor, defaultGroup } from '@/client/components/account-trigger/ConditionBuilder'
import type { AccountTriggerSummary, ConditionNode, TriggerDispatchMode } from '@/shared/types'

interface EmailFolder { id: string; name: string }

interface Props {
  accountId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
  /** When set, the dialog edits this trigger; otherwise it creates a new one. */
  trigger?: AccountTriggerSummary
}

export function AccountTriggerFormDialog({ accountId, open, onOpenChange, onSaved, trigger }: Props) {
  const { t } = useTranslation()
  const { agents } = useAgents()
  const agentOptions: AgentOption[] = agents.map((a) => ({ id: a.id, name: a.name, role: a.role ?? '', avatarUrl: a.avatarUrl }))

  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [folder, setFolder] = useState('INBOX')
  const [targetAgentId, setTargetAgentId] = useState('')
  const [dispatchMode, setDispatchMode] = useState<TriggerDispatchMode>('conversation')
  const [conditions, setConditions] = useState<ConditionNode>(defaultGroup())
  const [folders, setFolders] = useState<EmailFolder[]>([{ id: 'INBOX', name: 'INBOX' }])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | undefined>()

  // Initialize from the edited trigger (or defaults) whenever the dialog opens.
  useEffect(() => {
    if (!open) return
    setError(undefined)
    if (trigger) {
      setName(trigger.name)
      setPrompt(trigger.prompt)
      setFolder(trigger.folder)
      setTargetAgentId(trigger.targetAgentId)
      setDispatchMode(trigger.dispatchMode)
      setConditions(trigger.conditions)
    } else {
      setName('')
      setPrompt('')
      setFolder('INBOX')
      setTargetAgentId(agents[0]?.id ?? '')
      setDispatchMode('conversation')
      setConditions(defaultGroup())
    }
  }, [open, trigger, agents])

  // Load the account's folders for the picker.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const res = await api.get<{ folders: EmailFolder[] }>(`/email-accounts/${accountId}/folders`)
        if (!cancelled && res.folders.length > 0) setFolders(res.folders)
      } catch {
        // Keep the INBOX fallback.
      }
    })()
    return () => { cancelled = true }
  }, [open, accountId])

  const submit = async () => {
    setError(undefined)
    if (!name.trim()) return setError(t('settings.triggers.errorName'))
    if (!prompt.trim()) return setError(t('settings.triggers.errorPrompt'))
    if (!targetAgentId) return setError(t('settings.triggers.errorAgent'))

    setSubmitting(true)
    try {
      const body = { accountId, name: name.trim(), folder, conditions, prompt: prompt.trim(), targetAgentId, dispatchMode }
      if (trigger) await api.patch(`/account-triggers/${trigger.id}`, body)
      else await api.post('/account-triggers', body)
      onSaved()
      onOpenChange(false)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="3xl"
      title={trigger ? t('settings.triggers.editTitle') : t('settings.triggers.addTitle')}
      description={t('settings.triggers.dialogDescription')}
      error={error}
      onSubmit={() => void submit()}
      isSubmitting={submitting}
      submitLabel={trigger ? t('common.save') : t('common.create')}
    >
      <FormField label={t('settings.triggers.name')}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('settings.triggers.namePlaceholder')} />
      </FormField>

      <div className="grid grid-cols-2 gap-3">
        <FormField label={t('settings.triggers.folder')}>
          <Select value={folder} onValueChange={setFolder}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {folders.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  <span className="flex items-center gap-2">
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{f.name}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>

        <FormField label={t('settings.triggers.targetAgent')}>
          <AgentSelector
            value={targetAgentId}
            onValueChange={setTargetAgentId}
            agents={agentOptions}
            placeholder={t('settings.triggers.selectAgent')}
          />
        </FormField>
      </div>

      <FormField label={t('settings.triggers.dispatchMode')}>
        <Select value={dispatchMode} onValueChange={(v) => setDispatchMode(v as TriggerDispatchMode)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="conversation">{t('settings.triggers.dispatchConversation')}</SelectItem>
            <SelectItem value="task">{t('settings.triggers.dispatchTask')}</SelectItem>
          </SelectContent>
        </Select>
        {dispatchMode === 'task' ? (
          <div className="mt-1.5 flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning">
            <AlertTriangle className="mt-px size-3.5 shrink-0" />
            <span>{t('settings.triggers.dispatchTaskWarning')}</span>
          </div>
        ) : (
          <p className="mt-1.5 text-[11px] text-muted-foreground">{t('settings.triggers.dispatchConversationDesc')}</p>
        )}
      </FormField>

      <FormField label={t('settings.triggers.conditions')} hint={t('settings.triggers.conditionsHint')}>
        <ConditionNodeEditor node={conditions} onChange={setConditions} />
      </FormField>

      <FormField label={t('settings.triggers.prompt')} hint={dispatchMode === 'task' ? t('settings.triggers.promptHintTask') : t('settings.triggers.promptHint')}>
        <MarkdownEditor value={prompt} onChange={setPrompt} height="140px" />
      </FormField>
    </FormDialog>
  )
}
