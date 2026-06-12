import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/client/components/ui/command'
import { getFileIcon, formatFileSize } from '@/client/lib/file-icons'
import { useWorkspaceFileSearch } from '@/client/hooks/useWorkspaceFileSearch'

interface WorkspaceQuickOpenProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentId: string | null
  onPick: (path: string) => void
}

/**
 * Ctrl/Cmd+P quick open (files.md § 3.6) — same server search as the chat `@`
 * palette. Results are server-filtered: cmdk's own filtering is disabled.
 */
export function WorkspaceQuickOpen({ open, onOpenChange, agentId, onPick }: WorkspaceQuickOpenProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const { hits, isLoading } = useWorkspaceFileSearch({ query, agentId, enabled: open, limit: 20 })

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} shouldFilter={false}>
      <CommandInput placeholder={t('files.search.placeholder')} value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>{isLoading ? t('common.loading') : t('files.search.noResults')}</CommandEmpty>
        {hits.map((hit) => {
          const Icon = getFileIcon(hit.name)
          return (
            <CommandItem
              key={hit.path}
              value={hit.path}
              onSelect={() => {
                onOpenChange(false)
                onPick(hit.path)
              }}
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{hit.path}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{formatFileSize(hit.size)}</span>
            </CommandItem>
          )
        })}
      </CommandList>
    </CommandDialog>
  )
}
