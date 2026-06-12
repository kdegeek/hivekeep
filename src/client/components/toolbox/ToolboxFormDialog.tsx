import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Input } from '@/client/components/ui/input'
import { Textarea } from '@/client/components/ui/textarea'
import { Label } from '@/client/components/ui/label'
import { Loader2 } from 'lucide-react'
import { FormDialog } from '@/client/components/common/FormDialog'
import { FormField } from '@/client/components/common/FormField'
import { ToolSelector } from '@/client/components/common/ToolSelector'
import { useToolCatalog } from '@/client/hooks/useToolCatalog'
import { getErrorMessage } from '@/client/lib/api'
import type { CreateToolboxInput, UpdateToolboxInput } from '@/client/hooks/useToolboxes'
import type { Toolbox } from '@/shared/types'

interface ToolboxFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When set the dialog edits this toolbox; otherwise it creates a new one. */
  toolbox?: Toolbox | null
  onCreate: (input: CreateToolboxInput) => Promise<unknown>
  onUpdate: (id: string, input: UpdateToolboxInput) => Promise<unknown>
}

export function ToolboxFormDialog({
  open,
  onOpenChange,
  toolbox,
  onCreate,
  onUpdate,
}: ToolboxFormDialogProps) {
  const { t } = useTranslation()
  const { tools, isLoading: catalogLoading } = useToolCatalog()

  const isEdit = !!toolbox
  // Built-in toolboxes are read-only — the dialog renders as a viewer.
  const isReadOnly = !!toolbox?.builtin

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The built-in 'all' toolbox stores the wildcard "*" rather than every tool
  // name. Detect it so the editor can reflect "everything selected" without
  // listing each tool individually.
  const isWildcard = useMemo(
    () => (toolbox?.toolNames ?? []).includes('*'),
    [toolbox],
  )

  useEffect(() => {
    if (!open) return
    setError(null)
    setName(toolbox?.name ?? '')
    setDescription(toolbox?.description ?? '')
    if (isWildcard) {
      // Reflect what "*" grants by pre-selecting the native entries plus every
      // ENABLED custom tool — "*" expands to native + custom (MCP/plugin must
      // still be listed by name), so the read-only 'all' viewer mirrors that.
      setSelected(
        new Set(
          tools
            .filter(
              (tool) =>
                tool.source === 'native' || (tool.source === 'custom' && tool.enabled !== false),
            )
            .map((tool) => tool.name),
        ),
      )
    } else {
      setSelected(new Set(toolbox?.toolNames ?? []))
    }
  }, [open, toolbox, isWildcard, tools])

  async function handleSubmit() {
    const trimmed = name.trim()
    if (!trimmed) return
    setSubmitting(true)
    setError(null)
    try {
      const payload = {
        name: trimmed,
        description: description.trim() || null,
        toolNames: Array.from(selected),
      }
      if (isEdit && toolbox) {
        await onUpdate(toolbox.id, payload)
        toast.success(t('toolboxes.updated'))
      } else {
        await onCreate(payload)
        toast.success(t('toolboxes.created'))
      }
      onOpenChange(false)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      toast.error(message)
    } finally {
      setSubmitting(false)
    }
  }

  const selectedCount = isWildcard
    ? tools.filter(
        (tool) =>
          tool.source === 'native' || (tool.source === 'custom' && tool.enabled !== false),
      ).length
    : selected.size

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        isReadOnly
          ? t('toolboxes.form.viewTitle')
          : isEdit
            ? t('toolboxes.form.editTitle')
            : t('toolboxes.form.createTitle')
      }
      description={
        isReadOnly ? t('toolboxes.form.viewDescription') : t('toolboxes.form.description')
      }
      size="2xl"
      error={error}
      onSubmit={isReadOnly ? undefined : handleSubmit}
      isSubmitting={submitting}
      submitDisabled={!name.trim()}
      submitLabel={isEdit ? t('common.save') : t('common.create')}
      cancelLabel={isReadOnly ? t('common.close') : undefined}
    >
      <FormField label={t('toolboxes.form.nameField')} htmlFor="toolbox-name">
        <Input
          id="toolbox-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('toolboxes.form.namePlaceholder')}
          disabled={isReadOnly}
          autoFocus={!isReadOnly}
        />
      </FormField>

      <FormField label={t('toolboxes.form.descriptionField')} htmlFor="toolbox-description">
        <Textarea
          id="toolbox-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('toolboxes.form.descriptionPlaceholder')}
          rows={2}
          disabled={isReadOnly}
        />
      </FormField>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label>{t('toolboxes.form.toolsField')}</Label>
          <span className="text-xs text-muted-foreground">
            {t('toolboxes.form.selectedCount', { count: selectedCount })}
          </span>
        </div>
        {isWildcard && (
          <p className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {t('toolboxes.form.wildcardNote')}
          </p>
        )}
        {catalogLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <ToolSelector
            tools={tools}
            selected={selected}
            onChange={setSelected}
            readOnly={isReadOnly}
            toolNote={(tool) =>
              tool.hardExcludedFromSubAgent ? t('toolboxes.form.hardExcludedNote') : undefined
            }
          />
        )}
      </div>
    </FormDialog>
  )
}
