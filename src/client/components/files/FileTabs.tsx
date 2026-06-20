import { useState, type ComponentType, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  X,
  XCircle,
  CircleX,
  ArrowRightToLine,
  FolderTree,
  Link2,
  MoreHorizontal,
} from 'lucide-react'
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn } from '@/client/lib/utils'
import { ScrollArea, ScrollBar } from '@/client/components/ui/scroll-area'
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

/** Multi-close + navigation actions shared by the per-tab context menu and the bar "⋯". */
export interface FileTabActions {
  closeOthers: (path: string) => void
  closeToRight: (path: string) => void
  closeAll: () => void
  copyPath: (path: string) => void
  reveal: (path: string) => void
}

interface FileTabsProps {
  /** Open tab paths, in order. */
  tabs: string[]
  active: string | null
  dirtyPaths: Set<string>
  onSelect: (path: string) => void
  onClose: (path: string) => void
  /** Drag-reorder (no-op when omitted). */
  onReorder?: (activeId: string, overId: string) => void
  /** Context-menu actions (no menu when omitted). */
  actions?: FileTabActions
}

const nameOf = (path: string) => path.split('/').pop() ?? path

/** Pointer-fine only: on touch, dragging tabs would hijack the horizontal scroll. */
const finePointer = () => typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches

interface MenuParts {
  Item: ComponentType<{ onClick?: () => void; disabled?: boolean; children?: ReactNode }>
  Separator: ComponentType
}

interface TabProps {
  path: string
  isActive: boolean
  isDirty: boolean
  dndEnabled: boolean
  onSelect: (path: string) => void
  onClose: (path: string) => void
  menu?: (path: string, parts: MenuParts) => ReactNode
}

function SortableTab({ path, isActive, isDirty, dndEnabled, onSelect, onClose, menu }: TabProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: path,
    disabled: !dndEnabled,
  })
  const Icon = getFileIcon(nameOf(path))
  const row = (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      className={cn(
        'group flex max-w-48 shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-2.5 text-xs transition-colors',
        isActive
          ? 'bg-background text-foreground shadow-[inset_0_-2px_0_var(--color-primary)]'
          : 'bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground',
        isDragging && 'z-10 opacity-60',
      )}
      role="tab"
      aria-selected={isActive}
      title={path}
      onClick={() => onSelect(path)}
      onAuxClick={(e) => {
        // Middle-click closes (Ctrl/Cmd+W is browser-reserved).
        if (e.button === 1) {
          e.preventDefault()
          onClose(path)
        }
      }}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{nameOf(path)}</span>
      {isDirty && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="unsaved" />}
      <button
        type="button"
        className={cn(
          'rounded-sm p-0.5 text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground',
          !isDirty && 'opacity-0 group-hover:opacity-100 max-md:opacity-100',
        )}
        // Stop the drag sensor from swallowing the click on the close target.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onClose(path)
        }}
        aria-label={`close ${nameOf(path)}`}
      >
        <X className="size-3" />
      </button>
    </div>
  )

  if (!menu) return row
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {menu(path, { Item: ContextMenuItem, Separator: ContextMenuSeparator })}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * Light editor tabs (files.md § 3.4): dirty dot, close button, middle-click
 * close, horizontally scrollable on narrow screens, drag-to-reorder on fine
 * pointers, and a right-click / bar "⋯" menu (close others/right/all, reveal,
 * copy path). All tabs are pinned (no VSCode preview-tab mode in v1).
 */
export function FileTabs({ tabs, active, dirtyPaths, onSelect, onClose, onReorder, actions }: FileTabsProps) {
  const { t } = useTranslation()
  const [dndEnabled] = useState(finePointer)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  if (tabs.length === 0) return null

  const handleDragEnd = (e: DragEndEvent) => {
    const overId = e.over?.id
    if (overId && e.active.id !== overId) onReorder?.(String(e.active.id), String(overId))
  }

  const menu = actions
    ? (path: string, { Item, Separator }: MenuParts) => {
        const isLast = tabs.indexOf(path) === tabs.length - 1
        const lone = tabs.length <= 1
        return (
          <>
            <Item onClick={() => onClose(path)}>
              <X className="size-4" />
              {t('files.tabs.close')}
            </Item>
            <Item onClick={() => actions.closeOthers(path)} disabled={lone}>
              <XCircle className="size-4" />
              {t('files.tabs.closeOthers')}
            </Item>
            <Item onClick={() => actions.closeToRight(path)} disabled={isLast}>
              <ArrowRightToLine className="size-4" />
              {t('files.tabs.closeToRight')}
            </Item>
            <Item onClick={() => actions.closeAll()}>
              <CircleX className="size-4" />
              {t('files.tabs.closeAll')}
            </Item>
            <Separator />
            <Item onClick={() => actions.reveal(path)}>
              <FolderTree className="size-4" />
              {t('files.tabs.reveal')}
            </Item>
            <Item onClick={() => actions.copyPath(path)}>
              <Link2 className="size-4" />
              {t('files.tabs.copyPath')}
            </Item>
          </>
        )
      }
    : undefined

  return (
    <div className="flex shrink-0 items-stretch border-b border-border">
      <ScrollArea className="min-w-0 flex-1">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={tabs} strategy={horizontalListSortingStrategy}>
            <div className="flex h-9 items-stretch">
              {tabs.map((path) => (
                <SortableTab
                  key={path}
                  path={path}
                  isActive={path === active}
                  isDirty={dirtyPaths.has(path)}
                  dndEnabled={dndEnabled && !!onReorder}
                  onSelect={onSelect}
                  onClose={onClose}
                  menu={menu}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
        <ScrollBar orientation="horizontal" className="h-1.5" />
      </ScrollArea>
      {menu && active && (
        <DropdownMenu>
          <DropdownMenuTrigger
            className="flex w-8 shrink-0 items-center justify-center border-l border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('files.tabs.menu')}
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {menu(active, { Item: DropdownMenuItem, Separator: DropdownMenuSeparator })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
