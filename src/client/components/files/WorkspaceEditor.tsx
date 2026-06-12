import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Download, Eye, FileWarning, Loader2, Pencil, Save } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { CodeEditor } from '@/client/components/ui/code-editor'
import { ScrollArea } from '@/client/components/ui/scroll-area'
import { MarkdownContent } from '@/client/components/chat/MarkdownContent'
import { cn } from '@/client/lib/utils'
import { getFileIcon, formatFileSize } from '@/client/lib/file-icons'
import type { TabFileState } from '@/client/hooks/useWorkspaceTabs'

interface WorkspaceEditorProps {
  agentId: string
  path: string
  state: TabFileState
  onChangeDraft: (value: string) => void
  onSave: (opts?: { force?: boolean }) => void
  onReload: () => void
}

export function workspaceRawUrl(agentId: string, path: string, inline = false): string {
  return `/api/agents/${encodeURIComponent(agentId)}/workspace/raw?path=${encodeURIComponent(path)}${inline ? '&inline=1' : ''}`
}

const isMarkdown = (name: string) => /\.(md|markdown)$/i.test(name)

/**
 * Center pane of the Files section (files.md § 3.5): viewer picked from the
 * server-decided `kind`, edit/preview toggle for markdown, conflict and
 * deleted-on-disk banners, status bar. The text editor IS the shared
 * CodeEditor (extended with filename/onSave), not a fork.
 */
export function WorkspaceEditor({ agentId, path, state, onChangeDraft, onSave, onReload }: WorkspaceEditorProps) {
  const { t } = useTranslation()
  const [mdView, setMdView] = useState<'edit' | 'preview'>('edit')

  const { info } = state
  const name = path.split('/').pop() ?? path
  const Icon = getFileIcon(name)

  if (state.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (state.deletedOnDisk && !state.dirty) {
    // Clean tab whose file vanished: the page auto-closes it (P5); transient.
    return null
  }

  const downloadButton = info && (
    <Button asChild variant="outline" size="sm" className="gap-1.5">
      <a href={workspaceRawUrl(agentId, path)} download={name}>
        <Download className="size-4" />
        {t('files.editor.download')}
      </a>
    </Button>
  )

  const banner = state.conflict ? (
    <Banner
      tone="warning"
      icon={AlertTriangle}
      text={t('files.editor.conflict.message')}
      actions={
        <>
          <Button size="sm" variant="outline" onClick={onReload}>
            {t('files.editor.conflict.reload')}
          </Button>
          <Button size="sm" variant="destructive" onClick={() => onSave({ force: true })}>
            {t('files.editor.conflict.overwrite')}
          </Button>
        </>
      }
    />
  ) : state.deletedOnDisk ? (
    <Banner
      tone="destructive"
      icon={FileWarning}
      text={t('files.editor.deletedFromDisk')}
      actions={
        <Button size="sm" variant="outline" onClick={() => onSave({ force: true })}>
          {t('files.editor.recreate')}
        </Button>
      }
    />
  ) : state.error ? (
    <Banner tone="destructive" icon={AlertTriangle} text={state.error} />
  ) : null

  let body: React.ReactNode
  if (!info) {
    body = null
  } else {
    switch (info.kind) {
      case 'text': {
        const editable = (
          <CodeEditor
            value={state.draft}
            onChange={onChangeDraft}
            filename={name}
            height="100%"
            className="h-full rounded-none border-0 [&:has(.cm-focused)]:ring-0 [&:has(.cm-focused)]:border-0"
            onSave={() => onSave()}
          />
        )
        body = isMarkdown(name) && mdView === 'preview' ? (
          <ScrollArea className="h-full">
            <MarkdownContent content={state.draft} disableChatPlugins className="max-w-3xl p-4" />
          </ScrollArea>
        ) : (
          editable
        )
        break
      }
      case 'image':
        body = (
          <div className="flex h-full items-center justify-center overflow-auto bg-muted/30 p-4">
            <img
              src={workspaceRawUrl(agentId, path, true)}
              alt={name}
              className="max-h-full max-w-full rounded-md border border-border object-contain"
            />
          </div>
        )
        break
      case 'pdf':
        body = <iframe src={workspaceRawUrl(agentId, path, true)} title={name} className="h-full w-full border-0" />
        break
      default:
        body = (
          <div className="flex h-full items-center justify-center p-6">
            <div className="flex max-w-sm flex-col items-center gap-3 text-center">
              <FileWarning className="size-8 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">{name}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {info.kind === 'too-large'
                    ? t('files.editor.tooLarge', { size: formatFileSize(info.size) })
                    : t('files.editor.binary', { mime: info.mimeType })}
                </p>
              </div>
              {downloadButton}
            </div>
          </div>
        )
    }
  }

  const isText = info?.kind === 'text'

  return (
    <div className="flex h-full min-h-0 flex-col">
      {banner}
      {isText && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
          {isMarkdown(name) && (
            <div className="flex items-center rounded-md bg-muted/60 p-0.5">
              <ToolbarToggle active={mdView === 'edit'} onClick={() => setMdView('edit')} icon={Pencil} label={t('files.editor.edit')} />
              <ToolbarToggle active={mdView === 'preview'} onClick={() => setMdView('preview')} icon={Eye} label={t('files.editor.preview')} />
            </div>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              size="sm"
              variant={state.dirty ? 'default' : 'ghost'}
              className="gap-1.5"
              disabled={!state.dirty || state.isSaving}
              onClick={() => onSave()}
            >
              {state.isSaving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              {state.dirty ? t('files.editor.save') : t('files.editor.saved')}
            </Button>
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1">{body}</div>
      {info && (
        <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1 text-[11px] text-muted-foreground">
          <Icon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={path}>
            {path}
          </span>
          <span className="shrink-0">{formatFileSize(info.size)}</span>
          <span className="shrink-0 max-sm:hidden">{new Date(info.modifiedAt).toLocaleString()}</span>
        </div>
      )}
    </div>
  )
}

function Banner({
  tone,
  icon: BannerIcon,
  text,
  actions,
}: {
  tone: 'warning' | 'destructive'
  icon: typeof AlertTriangle
  text: string
  actions?: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 text-xs',
        tone === 'warning'
          ? 'border-warning/30 bg-warning/10 text-warning-foreground'
          : 'border-destructive/30 bg-destructive/10 text-destructive',
      )}
    >
      <BannerIcon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{text}</span>
      {actions && <div className="flex items-center gap-1.5">{actions}</div>}
    </div>
  )
}

function ToolbarToggle({
  active,
  onClick,
  icon: ToggleIcon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: typeof Pencil
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors',
        active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <ToggleIcon className="size-3" />
      {label}
    </button>
  )
}
