import { memo, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar, AvatarImage, AvatarFallback } from '@/client/components/ui/avatar'
import { cn } from '@/client/lib/utils'
import { getFileIcon, formatFileSize } from '@/client/lib/file-icons'
import type { MentionableUser, MentionableAgent } from '@/client/hooks/useMentionables'
import type { WorkspaceFileHit } from '@/client/hooks/useWorkspaceFileSearch'

export interface MentionItem {
  type: 'user' | 'agent' | 'file'
  id: string
  /** The text to insert (pseudonym for users, slug for agents, path for files) */
  handle: string
  /** Display name (basename for files) */
  name: string
  avatarUrl: string | null
  /** Secondary metadata, e.g. "2.5 KB" for files. */
  meta?: string
}

const MAX_PEOPLE = 8
const MAX_FILES = 8

/**
 * Single source of truth for the filtered, ordered, grouped item list — the
 * component, the keyboard-nav count and the Enter/Tab resolution all derive
 * from this so they can never drift apart (files.md § 5.1).
 */
export function buildMentionItems(
  query: string,
  users: MentionableUser[],
  agents: MentionableAgent[],
  files: WorkspaceFileHit[] = [],
): MentionItem[] {
  const lowerQuery = query.toLowerCase()
  const people: MentionItem[] = []

  for (const u of users) {
    if (u.pseudonym.toLowerCase().includes(lowerQuery) || u.firstName.toLowerCase().includes(lowerQuery)) {
      people.push({ type: 'user', id: u.id, handle: u.pseudonym, name: u.firstName, avatarUrl: u.avatarUrl })
    }
  }
  for (const k of agents) {
    const slug = k.slug ?? k.name.toLowerCase().replace(/\s+/g, '-')
    if (slug.toLowerCase().includes(lowerQuery) || k.name.toLowerCase().includes(lowerQuery)) {
      people.push({ type: 'agent', id: k.id, handle: slug, name: k.name, avatarUrl: k.avatarUrl })
    }
  }

  // Files come pre-filtered by the server (useWorkspaceFileSearch).
  const fileItems: MentionItem[] = files.slice(0, MAX_FILES).map((f) => ({
    type: 'file',
    id: f.path,
    handle: f.path,
    name: f.name,
    avatarUrl: null,
    meta: formatFileSize(f.size),
  }))

  return [...people.slice(0, MAX_PEOPLE), ...fileItems]
}

interface MentionPopoverProps {
  query: string
  users: MentionableUser[]
  agents: MentionableAgent[]
  files?: WorkspaceFileHit[]
  selectedIndex: number
  position: { top: number; left: number }
  onSelect: (item: MentionItem) => void
}

export const MentionPopover = memo(function MentionPopover({
  query,
  users,
  agents,
  files,
  selectedIndex,
  position,
  onSelect,
}: MentionPopoverProps) {
  const { t } = useTranslation()
  const listRef = useRef<HTMLDivElement>(null)

  const items = useMemo(() => buildMentionItems(query, users, agents, files), [query, users, agents, files])

  // Scroll selected item into view
  useEffect(() => {
    const container = listRef.current
    if (!container) return
    const selected = container.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`)
    selected?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (items.length === 0) {
    return (
      <div
        className="absolute z-50 w-64 rounded-lg border border-border bg-popover p-2 shadow-lg"
        style={{ bottom: position.top, left: position.left }}
      >
        <p className="text-xs text-muted-foreground px-2 py-1">
          {t('chat.mention.noResults')}
        </p>
      </div>
    )
  }

  const firstFileIndex = items.findIndex((i) => i.type === 'file')

  return (
    <div
      className="absolute z-50 w-64 rounded-lg border border-border bg-popover shadow-lg overflow-hidden"
      style={{ bottom: position.top, left: position.left }}
    >
      <div ref={listRef} className="max-h-56 overflow-y-auto py-1">
        {items.map((item, i) => {
          const FileIcon = item.type === 'file' ? getFileIcon(item.name) : null
          return (
            <div key={`${item.type}-${item.id}`}>
              {/* Group header before the first file row */}
              {i === firstFileIndex && item.type === 'file' && (
                <p className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t('chat.mention.files')}
                </p>
              )}
              <button
                type="button"
                data-index={i}
                className={cn(
                  'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm transition-colors',
                  i === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50',
                )}
                onMouseDown={(e) => {
                  e.preventDefault() // Don't steal focus from textarea
                  onSelect(item)
                }}
              >
                {FileIcon ? (
                  <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Avatar className="size-5 shrink-0">
                    {item.avatarUrl ? (
                      <AvatarImage src={item.avatarUrl} alt={item.name} />
                    ) : (
                      <AvatarFallback className="text-[10px]">
                        {item.name.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    )}
                  </Avatar>
                )}
                <div className="min-w-0 flex-1">
                  <span className="truncate font-medium">{item.name}</span>
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {item.type === 'file' ? item.meta : `@${item.handle}`}
                  </span>
                </div>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                    item.type === 'user'
                      ? 'bg-primary/15 text-primary'
                      : item.type === 'agent'
                        ? 'bg-chart-4/20 text-chart-4'
                        : 'bg-muted text-muted-foreground',
                  )}
                >
                  {item.type === 'user'
                    ? t('chat.mention.users')
                    : item.type === 'agent'
                      ? t('chat.mention.agents')
                      : t('chat.mention.files')}
                </span>
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
})

/** Total filtered item count (keyboard navigation bounds in MessageInput). */
export function getMentionItemCount(
  query: string,
  users: MentionableUser[],
  agents: MentionableAgent[],
  files: WorkspaceFileHit[] = [],
): number {
  return buildMentionItems(query, users, agents, files).length
}

/** Filtered item by index (Enter/Tab selection in MessageInput). */
export function getMentionItemAt(
  index: number,
  query: string,
  users: MentionableUser[],
  agents: MentionableAgent[],
  files: WorkspaceFileHit[] = [],
): MentionItem | null {
  return buildMentionItems(query, users, agents, files)[index] ?? null
}
