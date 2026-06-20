import { Fragment, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Crosshair, Download, Eye, FileWarning, GitCompare, Loader2, Pencil, Save, WrapText } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { CodeEditor } from '@/client/components/ui/code-editor'
import { ScrollArea } from '@/client/components/ui/scroll-area'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/client/components/ui/breadcrumb'
import { MarkdownContent } from '@/client/components/chat/MarkdownContent'
import { WorkspaceDiffView } from '@/client/components/files/WorkspaceDiffView'
import { WorkspaceImageView } from '@/client/components/files/WorkspaceImageView'
import { cn } from '@/client/lib/utils'
import { getFileIcon, formatFileSize } from '@/client/lib/file-icons'
import { workspaceRawUrl } from '@/client/lib/workspace-source'
import type { TabFileState } from '@/client/hooks/useWorkspaceTabs'
import type { WorkspaceSourceRef } from '@/shared/types'

interface WorkspaceEditorProps {
  source: WorkspaceSourceRef
  path: string
  state: TabFileState
  onChangeDraft: (value: string) => void
  onSave: (opts?: { force?: boolean }) => void
  onReload: () => void
  /** Reveal a parent directory of the file in the tree (breadcrumb segment click). */
  onRevealDir?: (dirPath: string) => void
  /** Reveal the active file itself in the tree (select + expand ancestors). */
  onRevealFile?: (path: string) => void
  /** Source is a git repo: enables the per-file Diff toggle. */
  gitRepo?: boolean
}

export { workspaceRawUrl }

const isMarkdown = (name: string) => /\.(md|markdown)$/i.test(name)
const WRAP_KEY = 'files.editor.wrap'

/**
 * Center pane of the Files section (files.md § 3.5): viewer picked from the
 * server-decided `kind`, edit/preview toggle for markdown, conflict and
 * deleted-on-disk banners, status bar. The text editor IS the shared
 * CodeEditor (extended with filename/onSave), not a fork.
 */
export function WorkspaceEditor({ source, path, state, onChangeDraft, onSave, onReload, onRevealDir, onRevealFile, gitRepo }: WorkspaceEditorProps) {
  const { t } = useTranslation()
  const [mdView, setMdView] = useState<'edit' | 'preview'>('edit')
  const [wrap, setWrap] = useState(() => localStorage.getItem(WRAP_KEY) !== 'false')
  const [cursor, setCursor] = useState<{ line: number; col: number; selLen: number } | null>(null)
  const [language, setLanguage] = useState<string | null>(null)
  const [showDiff, setShowDiff] = useState(false)

  useEffect(() => {
    localStorage.setItem(WRAP_KEY, String(wrap))
  }, [wrap])

  // Drop diff mode when switching files.
  useEffect(() => {
    setShowDiff(false)
  }, [path])

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
      <a href={workspaceRawUrl(source, path)} download={name}>
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
            search
            lineWrapping={wrap}
            onCursorChange={setCursor}
            onLanguageChange={setLanguage}
            className="h-full rounded-none border-0 [&:has(.cm-focused)]:ring-0 [&:has(.cm-focused)]:border-0"
            onSave={() => onSave()}
          />
        )
        body = showDiff ? (
          <WorkspaceDiffView source={source} path={path} />
        ) : isMarkdown(name) && mdView === 'preview' ? (
          <ScrollArea className="h-full">
            <MarkdownContent content={state.draft} disableChatPlugins className="max-w-3xl p-4" />
          </ScrollArea>
        ) : (
          editable
        )
        break
      }
      case 'image':
        body = <WorkspaceImageView src={workspaceRawUrl(source, path, true)} alt={name} />
        break
      case 'pdf':
        body = <iframe src={workspaceRawUrl(source, path, true)} title={name} className="h-full w-full border-0" />
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

  const segments = path.split('/')

  return (
    <div className="flex h-full min-h-0 flex-col">
      {banner}
      {info && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2.5 py-1">
          <Breadcrumb className="min-w-0 flex-1 overflow-x-auto">
            <BreadcrumbList className="flex-nowrap gap-1 text-[11px] sm:gap-1.5">
              {segments.map((seg, i) => {
                const isLast = i === segments.length - 1
                const dirPath = segments.slice(0, i + 1).join('/')
                return (
                  <Fragment key={dirPath}>
                    <BreadcrumbItem>
                      {isLast ? (
                        <BreadcrumbPage className="flex items-center gap-1 whitespace-nowrap">
                          <Icon className="size-3.5 shrink-0" />
                          {seg}
                        </BreadcrumbPage>
                      ) : onRevealDir ? (
                        <BreadcrumbLink asChild>
                          <button type="button" className="whitespace-nowrap" onClick={() => onRevealDir(dirPath)}>
                            {seg}
                          </button>
                        </BreadcrumbLink>
                      ) : (
                        <span className="whitespace-nowrap text-muted-foreground">{seg}</span>
                      )}
                    </BreadcrumbItem>
                    {!isLast && <BreadcrumbSeparator />}
                  </Fragment>
                )
              })}
            </BreadcrumbList>
          </Breadcrumb>
          {onRevealFile && (
            <Button
              size="icon-xs"
              variant="ghost"
              className="shrink-0"
              onClick={() => onRevealFile(path)}
              title={t('files.tabs.reveal')}
              aria-label={t('files.tabs.reveal')}
            >
              <Crosshair className="size-3.5" />
            </Button>
          )}
        </div>
      )}
      {isText && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
          {isMarkdown(name) && (
            <div className="flex items-center rounded-md bg-muted/60 p-0.5">
              <ToolbarToggle active={mdView === 'edit'} onClick={() => setMdView('edit')} icon={Pencil} label={t('files.editor.edit')} />
              <ToolbarToggle active={mdView === 'preview'} onClick={() => setMdView('preview')} icon={Eye} label={t('files.editor.preview')} />
            </div>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {gitRepo && (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-pressed={showDiff}
                className={cn(showDiff && 'text-primary')}
                onClick={() => setShowDiff((d) => !d)}
                title={t('files.editor.diff')}
                aria-label={t('files.editor.diff')}
              >
                <GitCompare className="size-4" />
              </Button>
            )}
            <Button
              size="icon-sm"
              variant="ghost"
              aria-pressed={wrap}
              className={cn(wrap && 'text-primary')}
              onClick={() => setWrap((w) => !w)}
              title={t('files.editor.wrap')}
              aria-label={t('files.editor.wrap')}
            >
              <WrapText className="size-4" />
            </Button>
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
          {isText && cursor && (
            <span className="shrink-0 tabular-nums max-sm:hidden">
              {t('files.editor.lineCol', { line: cursor.line, col: cursor.col })}
            </span>
          )}
          {isText && language && <span className="shrink-0 max-sm:hidden">{language}</span>}
          <span className="shrink-0">{formatFileSize(info.size)}</span>
          <span className="shrink-0 max-md:hidden">{new Date(info.modifiedAt).toLocaleString()}</span>
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
