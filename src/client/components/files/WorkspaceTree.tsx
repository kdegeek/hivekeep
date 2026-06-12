import { useState, useRef, useEffect, useCallback, type ComponentType, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight,
  ClipboardPaste,
  Copy,
  Download,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  Link2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Scissors,
  Trash2,
  Upload,
} from 'lucide-react'
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
} from '@dnd-kit/core'
import { cn } from '@/client/lib/utils'
import { Skeleton } from '@/client/components/ui/skeleton'
import { ScrollArea } from '@/client/components/ui/scroll-area'
import { Input } from '@/client/components/ui/input'
import { Button } from '@/client/components/ui/button'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/client/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/client/components/ui/dropdown-menu'
import { getFileIcon } from '@/client/lib/file-icons'
import { useWorkspaceClipboard, parentDirOf } from '@/client/hooks/useWorkspaceFiles'
import type { WorkspaceEntry } from '@/shared/types'
import type { WorkspaceDirState } from '@/client/hooks/useWorkspaceFiles'

/** Inline editing state: creating inside dirPath, or renaming an entry. */
interface EditingState {
  mode: 'create-file' | 'create-dir' | 'rename'
  dirPath: string
  /** rename only */
  entry?: WorkspaceEntry
}

export interface WorkspaceTreeActions {
  createFile: (dirPath: string, name: string) => Promise<void>
  createDir: (dirPath: string, name: string) => Promise<void>
  rename: (entry: WorkspaceEntry, newName: string) => Promise<void>
  moveInto: (entry: WorkspaceEntry, destDir: string) => Promise<void>
  requestDelete: (entry: WorkspaceEntry) => void
  download: (entry: WorkspaceEntry) => void
  copyRelativePath: (entry: WorkspaceEntry) => void
  clipboardSet: (entry: WorkspaceEntry, op: 'copy' | 'cut') => void
  clipboardPaste: (destDir: string) => Promise<void>
  uploadTo: (dirPath: string, files: File[]) => void
  /** P6 — share to file-storage. Optional until wired. */
  share?: (entry: WorkspaceEntry) => void
  /** P7 — insert path into the agent conversation draft. Optional until wired. */
  insertInChat?: (entry: WorkspaceEntry) => void
}

interface WorkspaceTreeProps {
  dirs: Record<string, WorkspaceDirState>
  expanded: Set<string>
  selectedPath: string | null
  onToggleDir: (path: string) => void
  onSelectFile: (entry: WorkspaceEntry) => void
  onSelectDir?: (entry: WorkspaceEntry) => void
  onRetryDir: (path: string) => void
  onRefresh: () => void
  actions: WorkspaceTreeActions
}

/** Indentation is capped so deep nodes stay readable at w-64 (files.md § 3.1). */
const indentFor = (depth: number) => Math.min(depth, 8) * 12

const finePointer = () => window.matchMedia('(pointer: fine)').matches

export function WorkspaceTree({
  dirs,
  expanded,
  selectedPath,
  onToggleDir,
  onSelectFile,
  onSelectDir,
  onRetryDir,
  onRefresh,
  actions,
}: WorkspaceTreeProps) {
  const { t } = useTranslation()
  const clipboard = useWorkspaceClipboard()
  const [editing, setEditing] = useState<EditingState | null>(null)
  const [osDropDir, setOsDropDir] = useState<string | null>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const uploadDirRef = useRef('')
  const treeRef = useRef<HTMLDivElement>(null)

  // Intra-workspace dnd: fine pointers only (touch drag would hijack the
  // Sheet's scroll — touch move goes through cut/paste, files.md § 4.2).
  const dndEnabled = finePointer()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const entryByPath = useCallback(
    (path: string): WorkspaceEntry | undefined => {
      const parent = dirs[parentDirOf(path)]
      return parent?.entries?.find((e) => e.path === path)
    },
    [dirs],
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const activeEntry = event.active.data.current?.entry as WorkspaceEntry | undefined
    const overDir = event.over?.id as string | undefined
    if (!activeEntry || overDir === undefined) return
    const destDir = String(overDir)
    if (destDir === parentDirOf(activeEntry.path)) return
    if (activeEntry.type === 'dir' && (destDir === activeEntry.path || destDir.startsWith(activeEntry.path + '/'))) return
    void actions.moveInto(activeEntry, destDir)
  }

  // Tree-scoped shortcuts (F2 / Delete / Mod-C/X/V) — only when the tree has
  // focus, never inside inputs/CodeMirror (files.md § 3.7).
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const entry = selectedPath ? entryByPath(selectedPath) : undefined
    const mod = e.ctrlKey || e.metaKey
    if (e.key === 'F2' && entry) {
      e.preventDefault()
      setEditing({ mode: 'rename', dirPath: parentDirOf(entry.path), entry })
    } else if (e.key === 'Delete' && entry) {
      e.preventDefault()
      actions.requestDelete(entry)
    } else if (mod && e.key.toLowerCase() === 'c' && entry) {
      e.preventDefault()
      actions.clipboardSet(entry, 'copy')
    } else if (mod && e.key.toLowerCase() === 'x' && entry) {
      e.preventDefault()
      actions.clipboardSet(entry, 'cut')
    } else if (mod && e.key.toLowerCase() === 'v' && clipboard) {
      e.preventDefault()
      const destDir = entry ? (entry.type === 'dir' ? entry.path : parentDirOf(entry.path)) : ''
      void actions.clipboardPaste(destDir)
    }
  }

  const openUploadPicker = (dirPath: string) => {
    uploadDirRef.current = dirPath
    uploadInputRef.current?.click()
  }

  const startEdit = (state: EditingState) => {
    if (state.mode !== 'rename' && state.dirPath && !expanded.has(state.dirPath)) onToggleDir(state.dirPath)
    setEditing(state)
  }

  // ── Shared menu definition (ContextMenu + "⋯" use the same items) ──────────
  interface MenuParts {
    Item: ComponentType<{ onClick?: (e: React.MouseEvent) => void; className?: string; children?: ReactNode }>
    Separator: ComponentType
  }

  const menuFor = (entry: WorkspaceEntry, parts: MenuParts) => {
    const { Item, Separator } = parts
    const isDir = entry.type === 'dir'
    return (
      <>
        {isDir ? (
          <>
            <Item onClick={() => startEdit({ mode: 'create-file', dirPath: entry.path })}>
              <FilePlus2 className="size-4" />
              {t('files.tree.newFile')}
            </Item>
            <Item onClick={() => startEdit({ mode: 'create-dir', dirPath: entry.path })}>
              <FolderPlus className="size-4" />
              {t('files.tree.newFolder')}
            </Item>
            <Item onClick={() => openUploadPicker(entry.path)}>
              <Upload className="size-4" />
              {t('files.tree.uploadHere')}
            </Item>
            <Separator />
          </>
        ) : null}
        <Item onClick={() => startEdit({ mode: 'rename', dirPath: parentDirOf(entry.path), entry })}>
          <Pencil className="size-4" />
          {t('files.tree.rename')}
        </Item>
        <Item onClick={() => actions.clipboardSet(entry, 'copy')}>
          <Copy className="size-4" />
          {t('files.tree.copy')}
        </Item>
        <Item onClick={() => actions.clipboardSet(entry, 'cut')}>
          <Scissors className="size-4" />
          {t('files.tree.cut')}
        </Item>
        {isDir && clipboard && (
          <Item onClick={() => void actions.clipboardPaste(entry.path)}>
            <ClipboardPaste className="size-4" />
            {t('files.tree.paste')}
          </Item>
        )}
        <Separator />
        {!isDir && (
          <Item onClick={() => actions.download(entry)}>
            <Download className="size-4" />
            {t('files.editor.download')}
          </Item>
        )}
        {!isDir && actions.share && (
          <Item onClick={() => actions.share!(entry)}>
            <Upload className="size-4 rotate-180" />
            {t('files.tree.share')}
          </Item>
        )}
        {!isDir && actions.insertInChat && (
          <Item onClick={() => actions.insertInChat!(entry)}>
            <ChevronRight className="size-4" />
            {t('files.tree.insertInChat')}
          </Item>
        )}
        <Item onClick={() => actions.copyRelativePath(entry)}>
          <Link2 className="size-4" />
          {t('files.tree.copyPath')}
        </Item>
        <Separator />
        <Item className="text-destructive focus:text-destructive" onClick={() => actions.requestDelete(entry)}>
          <Trash2 className="size-4" />
          {t('common.delete')}
        </Item>
      </>
    )
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  function renderEditRow(depth: number) {
    if (!editing) return null
    const initial = editing.mode === 'rename' ? (editing.entry?.name ?? '') : ''
    return (
      <InlineNameInput
        key="__edit"
        depth={depth}
        initial={initial}
        onCancel={() => setEditing(null)}
        onSubmit={async (name) => {
          const state = editing
          setEditing(null)
          if (!name || (state.mode === 'rename' && name === state.entry?.name)) return
          if (state.mode === 'create-file') await actions.createFile(state.dirPath, name)
          else if (state.mode === 'create-dir') await actions.createDir(state.dirPath, name)
          else if (state.entry) await actions.rename(state.entry, name)
        }}
      />
    )
  }

  function renderDir(path: string, depth: number) {
    const state = dirs[path]
    const editRow = editing && editing.mode !== 'rename' && editing.dirPath === path ? renderEditRow(depth) : null
    if (!state || (state.isLoading && state.entries === null)) {
      return (
        <div className="space-y-1 py-1" style={{ paddingLeft: indentFor(depth) + 8 }}>
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      )
    }
    if (state.error && state.entries === null) {
      return (
        <button
          type="button"
          onClick={() => onRetryDir(path)}
          className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs text-destructive hover:bg-muted"
          style={{ paddingLeft: indentFor(depth) + 8 }}
          title={state.error}
        >
          <RefreshCw className="size-3 shrink-0" />
          <span className="truncate">{t('files.tree.loadError')}</span>
        </button>
      )
    }
    const entries = state.entries ?? []
    if (entries.length === 0 && path !== '' && !editRow) {
      return (
        <div className="px-2 py-1 text-xs italic text-muted-foreground" style={{ paddingLeft: indentFor(depth) + 8 }}>
          {t('files.tree.emptyFolder')}
        </div>
      )
    }
    return (
      <>
        {editRow}
        {entries.map((entry) => (
          <TreeRow
            key={entry.path}
            entry={entry}
            depth={depth}
            isExpanded={entry.type === 'dir' && expanded.has(entry.path)}
            isSelected={selectedPath === entry.path}
            isCut={clipboard?.op === 'cut' && clipboard.path === entry.path}
            isOsDropTarget={osDropDir === entry.path}
            dndEnabled={dndEnabled}
            renaming={editing?.mode === 'rename' && editing.entry?.path === entry.path}
            renderEditRow={renderEditRow}
            menuFor={menuFor}
            onToggleDir={onToggleDir}
            onSelectFile={onSelectFile}
            onSelectDir={onSelectDir}
            onOsDropDir={setOsDropDir}
            onOsDropFiles={(dirPath, files) => actions.uploadTo(dirPath, files)}
          >
            {entry.type === 'dir' && expanded.has(entry.path) && renderDir(entry.path, depth + 1)}
          </TreeRow>
        ))}
      </>
    )
  }

  const rootDropzone = useDroppable({ id: '', disabled: !dndEnabled })

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={handleKeyDown}>
      {/* Tree header: visible entry points (rule 11) for create/upload/paste */}
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border px-1.5 py-1">
        <span className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t('files.tree.title')}
        </span>
        <div className="ml-auto flex items-center">
          <Button variant="ghost" size="icon-xs" title={t('files.tree.newFile')} aria-label={t('files.tree.newFile')} onClick={() => startEdit({ mode: 'create-file', dirPath: rootEditTarget(selectedPath, dirs) })}>
            <FilePlus2 className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-xs" title={t('files.tree.newFolder')} aria-label={t('files.tree.newFolder')} onClick={() => startEdit({ mode: 'create-dir', dirPath: rootEditTarget(selectedPath, dirs) })}>
            <FolderPlus className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-xs" title={t('files.tree.upload')} aria-label={t('files.tree.upload')} onClick={() => openUploadPicker(rootEditTarget(selectedPath, dirs))}>
            <Upload className="size-3.5" />
          </Button>
          {clipboard && (
            <Button variant="ghost" size="icon-xs" title={t('files.tree.paste')} aria-label={t('files.tree.paste')} onClick={() => void actions.clipboardPaste(rootEditTarget(selectedPath, dirs))}>
              <ClipboardPaste className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <ScrollArea className="min-h-0 flex-1">
          <div
            ref={(node) => {
              rootDropzone.setNodeRef(node)
              ;(treeRef as React.MutableRefObject<HTMLDivElement | null>).current = node
            }}
            role="tree"
            tabIndex={0}
            className={cn(
              'min-h-full p-1.5 outline-none',
              (rootDropzone.isOver || osDropDir === '') && 'rounded-md ring-2 ring-primary/40',
            )}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('Files')) {
                e.preventDefault()
                if (osDropDir === null) setOsDropDir('')
              }
            }}
            onDragLeave={(e) => {
              if (e.currentTarget === e.target) setOsDropDir(null)
            }}
            onDrop={(e) => {
              if (e.dataTransfer.files.length > 0) {
                e.preventDefault()
                const dir = osDropDir ?? ''
                setOsDropDir(null)
                actions.uploadTo(dir, Array.from(e.dataTransfer.files))
              }
            }}
          >
            {renderDir('', 0)}
          </div>
        </ScrollArea>
      </DndContext>

      <input
        ref={uploadInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = e.target.files ? Array.from(e.target.files) : []
          e.target.value = ''
          if (files.length > 0) actions.uploadTo(uploadDirRef.current, files)
        }}
      />
    </div>
  )
}

/** Where header-level create/upload land: the selected dir, else the root. */
function rootEditTarget(selectedPath: string | null, dirs: Record<string, WorkspaceDirState>): string {
  if (!selectedPath) return ''
  const parent = parentDirOf(selectedPath)
  const entry = dirs[parent]?.entries?.find((e) => e.path === selectedPath)
  return entry?.type === 'dir' ? entry.path : parent
}

// ─── Row ─────────────────────────────────────────────────────────────────────

interface TreeRowProps {
  entry: WorkspaceEntry
  depth: number
  isExpanded: boolean
  isSelected: boolean
  isCut: boolean
  isOsDropTarget: boolean
  dndEnabled: boolean
  renaming: boolean
  renderEditRow: (depth: number) => ReactNode
  menuFor: (entry: WorkspaceEntry, parts: { Item: ComponentType<any>; Separator: ComponentType }) => ReactNode
  onToggleDir: (path: string) => void
  onSelectFile: (entry: WorkspaceEntry) => void
  onSelectDir?: (entry: WorkspaceEntry) => void
  onOsDropDir: (dir: string | null) => void
  onOsDropFiles: (dir: string, files: File[]) => void
  children?: ReactNode
}

function TreeRow({
  entry,
  depth,
  isExpanded,
  isSelected,
  isCut,
  isOsDropTarget,
  dndEnabled,
  renaming,
  renderEditRow,
  menuFor,
  onToggleDir,
  onSelectFile,
  onSelectDir,
  onOsDropDir,
  onOsDropFiles,
  children,
}: TreeRowProps) {
  const isDir = entry.type === 'dir'
  const draggable = useDraggable({ id: entry.path, data: { entry }, disabled: !dndEnabled })
  const droppable = useDroppable({ id: entry.path, disabled: !dndEnabled || !isDir })
  const RowIcon = isDir ? (isExpanded ? FolderOpen : Folder) : getFileIcon(entry.name)

  if (renaming) {
    return <>{renderEditRow(depth)}</>
  }

  const row = (
    <div
      ref={(node) => {
        draggable.setNodeRef(node)
        if (isDir) droppable.setNodeRef(node)
      }}
      {...draggable.listeners}
      {...draggable.attributes}
      className={cn(
        'group flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm transition-colors',
        isSelected ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted',
        isCut && 'opacity-50',
        (droppable.isOver || isOsDropTarget) && 'ring-2 ring-primary/40',
        draggable.isDragging && 'opacity-40',
      )}
      style={{ paddingLeft: indentFor(depth) + 8 }}
      title={entry.path}
      aria-current={isSelected ? 'true' : undefined}
      onClick={() => {
        if (isDir) {
          onToggleDir(entry.path)
          onSelectDir?.(entry)
        } else {
          onSelectFile(entry)
        }
      }}
      onDragOver={(e) => {
        if (isDir && e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          e.stopPropagation()
          onOsDropDir(entry.path)
        }
      }}
      onDrop={(e) => {
        if (isDir && e.dataTransfer.files.length > 0) {
          e.preventDefault()
          e.stopPropagation()
          onOsDropDir(null)
          onOsDropFiles(entry.path, Array.from(e.dataTransfer.files))
        }
      }}
    >
      {isDir ? (
        <ChevronRight
          className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', isExpanded && 'rotate-90')}
        />
      ) : (
        <span className="w-3.5 shrink-0" />
      )}
      <RowIcon className={cn('size-4 shrink-0', isDir ? 'text-primary/70' : 'text-muted-foreground')} />
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      {entry.isSymlink && <Link2 className="size-3 shrink-0 text-muted-foreground" aria-label="symlink" />}
      {/* "⋯" — hover-revealed on fine pointers, ALWAYS visible below md (rule 11: touch has no hover/right-click) */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="rounded-sm p-0.5 text-muted-foreground opacity-100 hover:bg-muted-foreground/20 hover:text-foreground md:opacity-0 md:group-hover:opacity-100 md:data-[state=open]:opacity-100"
            onClick={(e) => e.stopPropagation()}
            aria-label={`actions ${entry.name}`}
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52" onClick={(e) => e.stopPropagation()}>
          {menuFor(entry, { Item: DropdownMenuItem, Separator: DropdownMenuSeparator })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          {menuFor(entry, { Item: ContextMenuItem, Separator: ContextMenuSeparator })}
        </ContextMenuContent>
      </ContextMenu>
      {children}
    </div>
  )
}

// ─── Inline name input (create / rename) ─────────────────────────────────────

function InlineNameInput({
  depth,
  initial,
  onSubmit,
  onCancel,
}: {
  depth: number
  initial: string
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    // Pre-select the stem (not the extension) like VSCode's rename.
    const dot = initial.lastIndexOf('.')
    inputRef.current?.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [initial])

  return (
    <div className="px-2 py-0.5" style={{ paddingLeft: indentFor(depth) + 8 }}>
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-6 px-1.5 text-sm"
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') onSubmit(value.trim())
          if (e.key === 'Escape') onCancel()
        }}
        onBlur={() => {
          if (value.trim() && value !== initial) onSubmit(value.trim())
          else onCancel()
        }}
      />
    </div>
  )
}
