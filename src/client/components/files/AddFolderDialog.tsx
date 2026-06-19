import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderInput, Trash2 } from 'lucide-react'
import { FormDialog } from '@/client/components/common/FormDialog'
import { Input } from '@/client/components/ui/input'
import { Label } from '@/client/components/ui/label'
import { Button } from '@/client/components/ui/button'
import { getErrorMessage } from '@/client/lib/api'
import type { WorkspaceFolderDTO } from '@/shared/types'

interface AddFolderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  folders: WorkspaceFolderDTO[]
  onCreate: (label: string, path: string) => Promise<WorkspaceFolderDTO>
  onRemove: (id: string) => Promise<void>
  /** Called with the newly added folder so the page can switch to it. */
  onAdded?: (folder: WorkspaceFolderDTO) => void
}

/**
 * Manage the arbitrary FS folders shown in the Files selector: lists existing
 * folders (with a visible delete affordance — discoverability rule) and a small
 * add form. Reuses FormDialog for the standard modal shell.
 */
export function AddFolderDialog({ open, onOpenChange, folders, onCreate, onRemove, onAdded }: AddFolderDialogProps) {
  const { t } = useTranslation()
  const [label, setLabel] = useState('')
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const reset = () => {
    setLabel('')
    setPath('')
    setError(null)
  }

  const handleSubmit = async () => {
    setError(null)
    setIsSubmitting(true)
    try {
      const folder = await onCreate(label.trim(), path.trim())
      reset()
      onAdded?.(folder)
      onOpenChange(false)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
      title={t('files.addFolder.title')}
      description={t('files.addFolder.description')}
      size="md"
      error={error}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitDisabled={!label.trim() || !path.trim()}
      submitLabel={t('files.addFolder.add')}
    >
      {folders.length > 0 && (
        <div className="mb-4 space-y-1">
          <Label className="text-xs text-muted-foreground">{t('files.addFolder.existing')}</Label>
          <div className="rounded-md border border-border divide-y divide-border">
            {folders.map((folder) => (
              <div key={folder.id} className="flex items-center gap-2 px-2.5 py-1.5">
                <FolderInput className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{folder.label}</span>
                  <span className="block truncate text-[11px] text-muted-foreground" title={folder.path}>
                    {folder.path}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={t('common.delete')}
                  onClick={() => void onRemove(folder.id)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="folder-label">{t('files.addFolder.labelField')}</Label>
          <Input
            id="folder-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('files.addFolder.labelPlaceholder')}
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="folder-path">{t('files.addFolder.pathField')}</Label>
          <Input
            id="folder-path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/home/user/projects"
            className="font-mono text-sm"
          />
          <p className="text-[11px] text-muted-foreground">{t('files.addFolder.pathHint')}</p>
        </div>
      </div>
    </FormDialog>
  )
}
