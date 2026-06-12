import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Textarea } from '@/client/components/ui/textarea'
import { Input } from '@/client/components/ui/input'
import { FormDialog } from '@/client/components/common/FormDialog'
import { FormField, FormRow } from '@/client/components/common/FormField'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/client/components/ui/select'
import { AgentSelector } from '@/client/components/common/AgentSelector'
import type { AgentOption } from '@/client/components/common/AgentSelectItem'
import { MEMORY_CATEGORIES } from '@/shared/constants'
import type { MemorySummary, MemoryCategory, MemoryScope } from '@/shared/types'

interface MemoryFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (agentId: string, data: { content: string; category: MemoryCategory; subject?: string; scope?: MemoryScope }) => Promise<void>
  onUpdate?: (memoryId: string, agentId: string, data: { content?: string; category?: MemoryCategory; subject?: string | null; scope?: MemoryScope }) => Promise<void>
  memory?: MemorySummary | null
  agentId?: string | null
  agents?: AgentOption[]
}

export function MemoryFormDialog({
  open,
  onOpenChange,
  onSave,
  onUpdate,
  memory,
  agentId,
  agents,
}: MemoryFormDialogProps) {
  const { t } = useTranslation()
  const isEdit = !!memory

  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [content, setContent] = useState('')
  const [category, setCategory] = useState<MemoryCategory>('fact')
  const [subject, setSubject] = useState('')
  const [scope, setScope] = useState<MemoryScope>('private')
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (memory) {
      setContent(memory.content)
      setCategory(memory.category)
      setSubject(memory.subject ?? '')
      setScope(memory.scope ?? 'private')
      setSelectedAgentId(memory.agentId)
    } else {
      setContent('')
      setCategory('fact')
      setSubject('')
      setScope('private')
      setSelectedAgentId(agentId ?? '')
    }
  }, [memory, agentId, open])

  const handleSubmit = async () => {
    setIsLoading(true)

    try {
      if (isEdit && onUpdate && memory) {
        await onUpdate(memory.id, memory.agentId, {
          content,
          category,
          subject: subject || null,
          scope,
        })
      } else {
        const targetAgentId = agentId ?? selectedAgentId
        if (!targetAgentId) return
        await onSave(targetAgentId, {
          content,
          category,
          subject: subject || undefined,
          scope,
        })
      }
      onOpenChange(false)
    } catch {
      // Error handled by caller via toast
    } finally {
      setIsLoading(false)
    }
  }

  const showAgentPicker = !agentId && !isEdit
  const canSubmit = !!(content.trim() && category && (agentId || selectedAgentId || isEdit))

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? t('settings.memories.edit') : t('settings.memories.add')}
      size="lg"
      onSubmit={handleSubmit}
      isSubmitting={isLoading}
      submitDisabled={!canSubmit}
      submitLabel={t('common.save')}
    >
      {showAgentPicker && agents && agents.length > 0 && (
        <FormField label={t('settings.memories.agent')} tip={t('settings.memories.agentTip')}>
          <AgentSelector
            value={selectedAgentId}
            onValueChange={setSelectedAgentId}
            agents={agents}
            placeholder={t('settings.memories.agentPlaceholder')}
          />
        </FormField>
      )}

      <FormField
        label={t('settings.memories.content')}
        htmlFor="memory-content"
        tip={t('settings.memories.contentTip')}
        required
      >
        <Textarea
          id="memory-content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={t('settings.memories.contentPlaceholder')}
          rows={3}
          required
        />
      </FormField>

      <FormRow>
        <FormField
          label={t('settings.memories.categoryLabel')}
          htmlFor="memory-category"
          tip={t('settings.memories.categoryTip')}
          required
        >
          <Select value={category} onValueChange={(v) => setCategory(v as MemoryCategory)}>
            <SelectTrigger id="memory-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MEMORY_CATEGORIES.map((cat) => (
                <SelectItem key={cat} value={cat}>
                  {t(`settings.memories.category.${cat}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>

        <FormField
          label={t('settings.memories.subject')}
          htmlFor="memory-subject"
          tip={t('settings.memories.subjectTip')}
        >
          <Input
            id="memory-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder={t('settings.memories.subjectPlaceholder')}
          />
        </FormField>
      </FormRow>

      <FormField
        label={t('settings.memories.scopeLabel')}
        htmlFor="memory-scope"
        tip={t('settings.memories.scopeTip')}
      >
        <Select value={scope} onValueChange={(v) => setScope(v as MemoryScope)}>
          <SelectTrigger id="memory-scope">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="private">{t('settings.memories.scopePrivate')}</SelectItem>
            <SelectItem value="shared">{t('settings.memories.scopeShared')}</SelectItem>
          </SelectContent>
        </Select>
      </FormField>
    </FormDialog>
  )
}
