import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Badge } from '@/client/components/ui/badge'
import { ExternalLink, GitCommitHorizontal } from 'lucide-react'
import type { ChangelogEntry, UpdateChannel } from '@/shared/types'

interface UpdateChangelogProps {
  changelog: ChangelogEntry[]
  channel: UpdateChannel
}

/** Cumulative changelog between the running version and the proposed one.
 *  Stable channel: one markdown section per intermediate release.
 *  Edge channel: a compact commit list. */
export function UpdateChangelog({ changelog, channel }: UpdateChangelogProps) {
  const { t } = useTranslation()

  if (changelog.length === 0) return null

  if (channel === 'edge') {
    return (
      <div className="rounded-md bg-muted/50 divide-y divide-border/50">
        {changelog.map((entry) => (
          <div key={entry.version} className="flex items-start gap-2 px-3 py-2">
            <GitCommitHorizontal className="size-3.5 mt-0.5 shrink-0 text-muted-foreground/60" />
            <span className="min-w-0 flex-1 text-xs break-words">{entry.title}</span>
            {entry.url ? (
              <a
                href={entry.url}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 font-mono text-[10px] text-primary hover:underline"
              >
                {entry.version}
              </a>
            ) : (
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {entry.version}
              </span>
            )}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {changelog.map((entry) => (
        <div key={entry.version} className="rounded-md bg-muted/50 p-3">
          <div className="mb-2 flex items-center gap-2">
            <Badge variant="default" className="text-[10px]">
              v{entry.version}
            </Badge>
            {entry.publishedAt && (
              <span className="text-[10px] text-muted-foreground">
                {new Date(entry.publishedAt).toLocaleDateString()}
              </span>
            )}
            {entry.url && (
              <a
                href={entry.url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
              >
                <ExternalLink className="size-2.5" />
                {t('updateAvailable.viewOnGitHub')}
              </a>
            )}
          </div>
          {entry.notes ? (
            <div className="text-xs text-muted-foreground prose prose-xs prose-neutral dark:prose-invert max-w-none prose-headings:text-xs prose-headings:font-semibold prose-p:my-1 prose-ul:my-1 prose-li:my-0 prose-pre:bg-muted prose-pre:text-xs prose-pre:overflow-x-auto prose-code:text-xs prose-code:break-all">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.notes}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">{entry.title}</p>
          )}
        </div>
      ))}
    </div>
  )
}
