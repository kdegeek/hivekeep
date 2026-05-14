import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, getErrorMessage } from '@/client/lib/api'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import { Plus, Trash2, Check, X, Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/client/lib/utils'
import type { ProjectTag } from '@/shared/types'

interface TagManagerProps {
  projectId: string
  tags: ProjectTag[]
}

/** A small color swatch + native color input combo. */
function ColorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label
      className="inline-block size-6 shrink-0 cursor-pointer rounded-md border border-border"
      style={{ backgroundColor: value }}
      title={value}
    >
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="sr-only"
      />
    </label>
  )
}

export function TagManager({ projectId, tags }: TagManagerProps) {
  const { t } = useTranslation()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [editColor, setEditColor] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newColor, setNewColor] = useState('#6b7280')
  const [busy, setBusy] = useState(false)

  function startEdit(tag: ProjectTag) {
    setEditingId(tag.id)
    setEditLabel(tag.label)
    setEditColor(tag.color)
  }

  function cancelEdit() {
    setEditingId(null)
    setEditLabel('')
    setEditColor('')
  }

  async function saveEdit() {
    if (!editingId || !editLabel.trim()) return
    setBusy(true)
    try {
      await api.patch(`/tags/${editingId}`, { label: editLabel.trim(), color: editColor })
      // SSE will update the parent via useProject — no local state to sync
      cancelEdit()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function deleteTag(tagId: string) {
    setBusy(true)
    try {
      await api.delete(`/tags/${tagId}`)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function createNewTag() {
    const label = newLabel.trim()
    if (!label) return
    setBusy(true)
    try {
      await api.post(`/projects/${projectId}/tags`, { label, color: newColor })
      setNewLabel('')
      setNewColor('#6b7280')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      {/* Existing tags */}
      {tags.length === 0 && (
        <p className="text-xs text-muted-foreground">{t('projects.tags.empty')}</p>
      )}
      <ul className="space-y-1.5">
        {tags.map((tag) => {
          const editing = editingId === tag.id
          return (
            <li key={tag.id} className="flex items-center gap-2">
              {editing ? (
                <>
                  <ColorPicker value={editColor} onChange={setEditColor} />
                  <Input
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveEdit()
                      if (e.key === 'Escape') cancelEdit()
                    }}
                    className="h-8 flex-1"
                    autoFocus
                  />
                  <Button size="icon" variant="ghost" className="size-7" onClick={saveEdit} disabled={busy || !editLabel.trim()}>
                    <Check className="size-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" className="size-7" onClick={cancelEdit} disabled={busy}>
                    <X className="size-3.5" />
                  </Button>
                </>
              ) : (
                <>
                  <span
                    className={cn(
                      'inline-flex h-7 flex-1 items-center gap-2 rounded-md border px-2 text-xs',
                    )}
                    style={{
                      backgroundColor: `${tag.color}15`,
                      borderColor: `${tag.color}40`,
                      color: tag.color,
                    }}
                  >
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    <span className="font-medium">{tag.label}</span>
                  </span>
                  <Button size="icon" variant="ghost" className="size-7" onClick={() => startEdit(tag)}>
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => deleteTag(tag.id)}
                    disabled={busy}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </>
              )}
            </li>
          )
        })}
      </ul>

      {/* Add new tag */}
      <div className="flex items-center gap-2 pt-2">
        <ColorPicker value={newColor} onChange={setNewColor} />
        <Input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') createNewTag()
          }}
          placeholder={t('projects.tags.newLabel')}
          className="h-8 flex-1"
        />
        <Button size="icon" variant="ghost" className="size-7" onClick={createNewTag} disabled={busy || !newLabel.trim()}>
          <Plus className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}
