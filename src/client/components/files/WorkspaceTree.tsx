import { useState, useRef, useEffect, useCallback, useMemo, type ComponentType, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
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
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
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
import { EmptyState } from '@/client/components/common/EmptyState'
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
  onCollapseAll?: () => void
  onExpandAll?: () => void
  actions: WorkspaceTreeActions
}

/** Indentation is capped so deep nodes stay readable at w-64 (files.md § 3.1). */
const indentFor = (depth: number) => Math.min(depth, 8) * 12

const finePointer = () => window.matchMedia('(pointer: fine)').matches

/**
 * Directory a drop on `overId`/`overEntry` would land in: a hovered folder maps
 * to itself, a hovered file to its parent (VSCode), the root droppable to ''.
 * Returns null when there is no droppable target.
 */
function resolveDropDir(
  overId: string | number | undefined,
  overEntry: WorkspaceEntry | undefined,
): string | null {
  if (overId === '') return ''
  if (!overEntry) return null
  return overEntry.type === 'dir' ? overEntry.path : parentDirOf(overEntry.path)
}

/** A move is a no-op (same parent) or illegal (a folder into itself/descendant). */
function isValidDrop(active: WorkspaceEntry, dir: string): boolean {
  if (dir === parentDirOf(active.path)) return false
  if (active.type === 'dir' && (dir === active.path || dir.startsWith(active.path + '/'))) return false
  return true
}

export function WorkspaceTree({
  dirs,
  expanded,
  selectedPath,
  onToggleDir,
  onSelectFile,
  onSelectDir,
  onRetryDir,
  onRefresh,
  onCollapseAll,
  onExpandAll,
  actions,
}: WorkspaceTreeProps) {
  const { t } = useTranslation()
  const clipboard = useWorkspaceClipboard()
  const [editing, setEditing] = useState<EditingState | null>(null)
  const [filter, setFilter] = useState('')
  const [osDropDir, setOsDropDir] = useState<string | null>(null)
  const [draggingEntry, setDraggingEntry] = useState<WorkspaceEntry | null>(null)
  // Directory a drop would land in during an intra-move drag (highlighted like
  // VSCode): the hovered folder, a hovered file's parent, '' for root, or null.
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const uploadDirRef = useRef('')
  const treeRef = useRef<HTMLDivElement>(null)
  // Pending auto-expand of a collapsed folder hovered during an intra-move drag.
  const autoExpandRef = useRef<{ path: string; timer: ReturnType<typeof setTimeout> } | null>(null)

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

  // Quick filter over already-loaded nodes (files.md v2): a node is visible when
  // its own name matches or a loaded descendant matches; matching folders are
  // force-expanded so the hits show through. Null when no filter is active.
  const query = filter.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!query) return null
    const visible = new Set<string>()
    const forceExpand = new Set<string>()
    const visit = (dirPath: string): boolean => {
      let any = false
      for (const e of dirs[dirPath]?.entries ?? []) {
        const selfMatch = e.name.toLowerCase().includes(query)
        if (e.type === 'dir') {
          const childHas = visit(e.path)
          if (selfMatch || childHas) {
            visible.add(e.path)
            if (childHas) forceExpand.add(e.path)
            any = true
          }
        } else if (selfMatch) {
          visible.add(e.path)
          any = true
        }
      }
      return any
    }
    visit('')
    return { visible, forceExpand }
  }, [query, dirs])

  const isOpen = (path: string) => (filtered ? filtered.forceExpand.has(path) : expanded.has(path))

  const clearAutoExpand = useCallback(() => {
    if (autoExpandRef.current) {
      clearTimeout(autoExpandRef.current.timer)
      autoExpandRef.current = null
    }
  }, [])

  useEffect(() => () => clearAutoExpand(), [clearAutoExpand])

  const handleDragStart = (event: DragStartEvent) => {
    setDraggingEntry((event.active.data.current?.entry as WorkspaceEntry | undefined) ?? null)
  }

  const handleDragOver = (event: DragOverEvent) => {
    const overEntry = event.over?.data.current?.entry as WorkspaceEntry | undefined
    const dir = resolveDropDir(event.over?.id, overEntry)
    // Highlight the destination folder (or root) only for a valid, distinct move.
    setDropTargetDir(draggingEntry && dir !== null && isValidDrop(draggingEntry, dir) ? dir : null)

    // Auto-expand a collapsed folder hovered directly (VSCode behaviour), so a
    // file can be dropped into a nested folder without pre-opening it.
    const hoveredDir = overEntry?.type === 'dir' ? overEntry.path : null
    const intoSelf =
      hoveredDir != null &&
      draggingEntry?.type === 'dir' &&
      (hoveredDir === draggingEntry.path || hoveredDir.startsWith(draggingEntry.path + '/'))
    if (!hoveredDir || intoSelf || expanded.has(hoveredDir)) {
      clearAutoExpand()
      return
    }
    if (autoExpandRef.current?.path === hoveredDir) return
    clearAutoExpand()
    autoExpandRef.current = {
      path: hoveredDir,
      timer: setTimeout(() => {
        onToggleDir(hoveredDir)
        autoExpandRef.current = null
      }, 600),
    }
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const activeEntry = event.active.data.current?.entry as WorkspaceEntry | undefined
    const overEntry = event.over?.data.current?.entry as WorkspaceEntry | undefined
    const dir = resolveDropDir(event.over?.id, overEntry)
    if (!activeEntry || dir === null || !isValidDrop(activeEntry, dir)) return
    void actions.moveInto(activeEntry, dir)
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
    const allEntries = state.entries ?? []
    const entries = filtered ? allEntries.filter((e) => filtered.visible.has(e.path)) : allEntries
    if (allEntries.length === 0 && path !== '' && !editRow && !filtered) {
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
            isExpanded={entry.type === 'dir' && isOpen(entry.path)}
            isSelected={selectedPath === entry.path}
            isCut={clipboard?.op === 'cut' && clipboard.path === entry.path}
            isOsDropTarget={osDropDir === entry.path}
            isDropTarget={entry.type === 'dir' && dropTargetDir === entry.path}
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
            {entry.type === 'dir' && isOpen(entry.path) && renderDir(entry.path, depth + 1)}
          </TreeRow>
        ))}
      </>
    )
  }

  const rootDropzone = useDroppable({ id: '', disabled: !dndEnabled })

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={handleKeyDown}>
      {/* Tree header: visible entry points (rule 11) for create/upload/paste */}
      <div className="shrink-0 border-b border-border px-1.5 py-1">
        <div className="flex items-center gap-0.5">
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
            {onExpandAll && (
              <Button variant="ghost" size="icon-xs" title={t('files.tree.expandAll')} aria-label={t('files.tree.expandAll')} onClick={onExpandAll}>
                <ChevronsUpDown className="size-3.5" />
              </Button>
            )}
            {onCollapseAll && (
              <Button variant="ghost" size="icon-xs" title={t('files.tree.collapseAll')} aria-label={t('files.tree.collapseAll')} onClick={onCollapseAll}>
                <ChevronsDownUp className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
        <div className="relative mt-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('files.tree.filter')}
            className="h-7 pl-7 pr-7 text-xs"
            aria-label={t('files.tree.filter')}
          />
          {filter && (
            <button
              type="button"
              onClick={() => setFilter('')}
              aria-label={t('common.clear')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={(e) => {
          clearAutoExpand()
          setDraggingEntry(null)
          setDropTargetDir(null)
          handleDragEnd(e)
        }}
        onDragCancel={() => {
          clearAutoExpand()
          setDraggingEntry(null)
          setDropTargetDir(null)
        }}
      >
        {/* The radix ScrollArea wraps its content in a display:table box that
            breaks `min-h-full` on the tree — force it to block + full height so
            the empty space below the last row stays a valid drop target
            (drop-to-root for both intra-move and OS upload). */}
        <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]>div]:min-h-full">
          <div
            ref={(node) => {
              rootDropzone.setNodeRef(node)
              ;(treeRef as React.MutableRefObject<HTMLDivElement | null>).current = node
            }}
            role="tree"
            tabIndex={0}
            className={cn(
              'min-h-full p-1.5 outline-none',
              (dropTargetDir === '' || osDropDir === '') && 'rounded-md bg-primary/5 ring-2 ring-inset ring-primary/60',
            )}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('Files')) {
                e.preventDefault()
                // Folder rows stopPropagation, so this only fires over the root
                // or a (non-dir) file row: always retarget root. Without the
                // reset the last hovered folder stayed sticky and stole the drop.
                if (osDropDir !== '') setOsDropDir('')
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
            {filtered && filtered.visible.size === 0 ? (
              <div className="px-2 py-6">
                <EmptyState minimal icon={Search} title={t('files.tree.noMatch')} />
              </div>
            ) : (
              renderDir('', 0)
            )}
          </div>
        </ScrollArea>
        <DragOverlay dropAnimation={null}>
          {draggingEntry &&
            (() => {
              const Icon = draggingEntry.type === 'dir' ? Folder : getFileIcon(draggingEntry.name)
              return (
                <div className="flex items-center gap-1.5 rounded-md border border-border bg-popover px-2 py-1 text-sm shadow-md">
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="max-w-48 truncate">{draggingEntry.name}</span>
                </div>
              )
            })()}
        </DragOverlay>
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
  isDropTarget: boolean
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
  isDropTarget,
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
  // Files are droppable too: dropping onto a file targets its parent folder
  // (resolved in handleDragEnd / the OS handlers below), like VSCode.
  const droppable = useDroppable({ id: entry.path, data: { entry }, disabled: !dndEnabled })
  const RowIcon = isDir ? (isExpanded ? FolderOpen : Folder) : getFileIcon(entry.name)
  // Directory an OS-file drop on this row lands in (folder → itself, file → parent).
  const osTargetDir = isDir ? entry.path : parentDirOf(entry.path)

  if (renaming) {
    return <>{renderEditRow(depth)}</>
  }

  const row = (
    <div
      ref={(node) => {
        draggable.setNodeRef(node)
        droppable.setNodeRef(node)
      }}
      {...draggable.listeners}
      {...draggable.attributes}
      className={cn(
        'group flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm transition-colors',
        isSelected ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted',
        isCut && 'opacity-50',
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
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          e.stopPropagation()
          onOsDropDir(osTargetDir)
        }
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length > 0) {
          e.preventDefault()
          e.stopPropagation()
          onOsDropDir(null)
          onOsDropFiles(osTargetDir, Array.from(e.dataTransfer.files))
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
    // The drop highlight wraps the row AND its rendered children, so dragging
    // over a folder lights up its whole region (row + contents), not just the
    // single folder line — much easier to spot in a folder full of files.
    <div className={cn((isDropTarget || isOsDropTarget) && 'rounded-md bg-primary/10 ring-1 ring-inset ring-primary/60')}>
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
