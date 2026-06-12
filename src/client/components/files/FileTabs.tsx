import { X } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import { ScrollArea, ScrollBar } from '@/client/components/ui/scroll-area'
import { getFileIcon } from '@/client/lib/file-icons'

interface FileTabsProps {
  /** Open tab paths, in order. */
  tabs: string[]
  active: string | null
  dirtyPaths: Set<string>
  onSelect: (path: string) => void
  onClose: (path: string) => void
}

const nameOf = (path: string) => path.split('/').pop() ?? path

/**
 * Light editor tabs (files.md § 3.4): dirty dot, close button, middle-click
 * close, horizontally scrollable on narrow screens. All tabs are pinned (no
 * VSCode preview-tab mode in v1).
 */
export function FileTabs({ tabs, active, dirtyPaths, onSelect, onClose }: FileTabsProps) {
  if (tabs.length === 0) return null

  return (
    <ScrollArea className="shrink-0 border-b border-border">
      <div className="flex h-9 items-stretch">
        {tabs.map((path) => {
          const isActive = path === active
          const isDirty = dirtyPaths.has(path)
          const Icon = getFileIcon(nameOf(path))
          return (
            <div
              key={path}
              className={cn(
                'group flex max-w-48 shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-2.5 text-xs transition-colors',
                isActive
                  ? 'bg-background text-foreground shadow-[inset_0_-2px_0_var(--color-primary)]'
                  : 'bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground',
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
        })}
      </div>
      <ScrollBar orientation="horizontal" className="h-1.5" />
    </ScrollArea>
  )
}
