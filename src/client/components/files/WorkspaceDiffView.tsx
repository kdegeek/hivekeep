import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { api, getErrorMessage } from '@/client/lib/api'
import { ScrollArea } from '@/client/components/ui/scroll-area'
import { EmptyState } from '@/client/components/common/EmptyState'
import { sourceApiBase, sourceQuery } from '@/client/lib/workspace-source'
import { cn } from '@/client/lib/utils'
import type { WorkspaceSourceRef } from '@/shared/types'

interface WorkspaceDiffViewProps {
  source: WorkspaceSourceRef
  path: string
}

/** Color one unified-diff line by its leading marker (palette tokens). */
function lineClass(line: string): string {
  if (line.startsWith('@@')) return 'text-info bg-info/10'
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-muted-foreground'
  if (line.startsWith('+')) return 'text-success bg-success/10'
  if (line.startsWith('-')) return 'text-destructive bg-destructive/10'
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'text-muted-foreground'
  return 'text-foreground/80'
}

/**
 * Read-only unified diff of a file vs HEAD (files.md v2). Renders the raw git
 * diff with per-line coloring rather than pulling in @codemirror/merge — no new
 * dependency, palette-driven, and good enough for a quick review.
 */
export function WorkspaceDiffView({ source, path }: WorkspaceDiffViewProps) {
  const { t } = useTranslation()
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setDiff(null)
    setError(null)
    api
      .get<{ diff: string; isRepo: boolean }>(`${sourceApiBase(source)}/git-diff${sourceQuery(source, { path })}`)
      .then((res) => {
        if (!cancelled) setDiff(res.diff)
      })
      .catch((err) => {
        if (!cancelled) setError(getErrorMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [source, path])

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState minimal title={error} />
      </div>
    )
  }
  if (diff === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (diff.trim() === '') {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState minimal title={t('files.editor.noChanges')} />
      </div>
    )
  }

  const lines = diff.replace(/\n$/, '').split('\n')
  return (
    <ScrollArea className="h-full">
      <pre className="min-w-full p-2 font-mono text-xs leading-5">
        {lines.map((line, i) => (
          <div key={i} className={cn('whitespace-pre px-2', lineClass(line))}>
            {line || ' '}
          </div>
        ))}
      </pre>
    </ScrollArea>
  )
}
