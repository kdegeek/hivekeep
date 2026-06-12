import { useNavigate } from 'react-router-dom'
import { useWorkspacePath } from '@/client/contexts/WorkspacePathContext'
import { getFileIcon } from '@/client/lib/file-icons'
import { cn } from '@/client/lib/utils'

interface WorkspacePathMentionProps {
  /** Candidate path emitted by remark-workspace-paths. */
  path: string
  /** The author wrote it in backticks — keep the mono look when degrading. */
  wasCode: boolean
}

/**
 * Inline chip for a workspace file path in a chat message (files.md § 5.2).
 * Renders as a clickable chip ONLY once the batched resolver confirmed the
 * file exists in the conversation agent's workspace; everything else degrades
 * to the original text — a regex false positive must never look interactive.
 */
export function WorkspacePathMention({ path, wasCode }: WorkspacePathMentionProps) {
  const { state, agentId } = useWorkspacePath(path)
  const navigate = useNavigate()

  if (state !== 'exists' || !agentId) {
    return wasCode ? <code>{path}</code> : <>{path}</>
  }

  const Icon = getFileIcon(path.split('/').pop() ?? path)
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        navigate(`/files/${agentId}?path=${encodeURIComponent(path)}`)
      }}
      title={path}
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-muted-foreground/10 px-1.5 py-0.5 align-baseline',
        'font-mono text-[0.85em] leading-none text-foreground transition-colors hover:bg-muted-foreground/20 hover:text-primary',
      )}
    >
      <Icon className="size-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{path}</span>
    </button>
  )
}
