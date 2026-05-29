import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
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
import { Textarea } from '@/client/components/ui/textarea'
import { Label } from '@/client/components/ui/label'
import { Loader2 } from 'lucide-react'
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

  // The built-in 'all' toolbox stores the wildcard "*" rather than every tool
  // name. Detect it so the editor can reflect "everything selected" without
  // listing each tool individually.
  const isWildcard = useMemo(
    () => (toolbox?.toolNames ?? []).includes('*'),
    [toolbox],
  )

  useEffect(() => {
    if (!open) return
    setName(toolbox?.name ?? '')
    setDescription(toolbox?.description ?? '')
    if (isWildcard) {
      // Reflect "all native tools" by pre-selecting only the native entries —
      // "*" expands to native tools only (plugin/MCP/custom must be listed by
      // name), so the read-only 'all' viewer must mirror that.
      setSelected(new Set(tools.filter((tool) => tool.source === 'native').map((tool) => tool.name)))
    } else {
      setSelected(new Set(toolbox?.toolNames ?? []))
    }
  }, [open, toolbox, isWildcard, tools])

  async function handleSubmit() {
    const trimmed = name.trim()
    if (!trimmed) return
    setSubmitting(true)
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
      toast.error(getErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  const selectedCount = isWildcard
    ? tools.filter((tool) => tool.source === 'native').length
    : selected.size

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isReadOnly
              ? t('toolboxes.form.viewTitle')
              : isEdit
                ? t('toolboxes.form.editTitle')
                : t('toolboxes.form.createTitle')}
          </DialogTitle>
          <DialogDescription>
            {isReadOnly ? t('toolboxes.form.viewDescription') : t('toolboxes.form.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-2 pr-1">
          <div className="space-y-1.5">
            <Label htmlFor="toolbox-name">{t('toolboxes.form.nameField')}</Label>
            <Input
              id="toolbox-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('toolboxes.form.namePlaceholder')}
              disabled={isReadOnly}
              autoFocus={!isReadOnly}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="toolbox-description">{t('toolboxes.form.descriptionField')}</Label>
            <Textarea
              id="toolbox-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('toolboxes.form.descriptionPlaceholder')}
              rows={2}
              disabled={isReadOnly}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
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
                  tool.hardExcludedFromSubKin ? t('toolboxes.form.hardExcludedNote') : undefined
                }
              />
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            {isReadOnly ? t('common.close') : t('common.cancel')}
          </Button>
          {!isReadOnly && (
            <Button onClick={handleSubmit} disabled={!name.trim() || submitting}>
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              {isEdit ? t('common.save') : t('common.create')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
