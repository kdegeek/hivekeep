import { useTranslation } from 'react-i18next'
import { GitBranch } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/client/components/ui/select'
import { cn } from '@/client/lib/utils'
import type { WorkspaceSourceRef, WorkspaceGitStatusDTO, WorkspaceWorktreeDTO } from '@/shared/types'

const BASE = '__base__'

interface WorkspaceProjectBarProps {
  source: WorkspaceSourceRef
  gitStatus: WorkspaceGitStatusDTO | null
  worktrees: WorkspaceWorktreeDTO[]
  /** Worktree id, '' for the base clone. */
  onSelectWorktree: (worktreeId: string) => void
}

/**
 * Secondary bar under the source selector when browsing a project repo: a
 * worktree sub-selector (base clone + live per-task worktrees) and a git badge
 * (current branch + uncommitted-change count). Renders nothing when there is no
 * git info and no worktree choice.
 */
export function WorkspaceProjectBar({ source, gitStatus, worktrees, onSelectWorktree }: WorkspaceProjectBarProps) {
  const { t } = useTranslation()
  const hasWorktreeChoice = source.type === 'project' && worktrees.length > 1
  if (!gitStatus && !hasWorktreeChoice) return null

  const worktreeLabel = (wt: WorkspaceWorktreeDTO) => {
    if (wt.isMain) return t('files.worktree.base')
    if (wt.ticketNumber != null) return t('files.worktree.ticket', { number: wt.ticketNumber, branch: wt.branch })
    return wt.branch || wt.id
  }

  return (
    <div className="flex flex-col gap-1.5 px-2 pb-2">
      {hasWorktreeChoice && (
        <Select value={source.worktree ?? BASE} onValueChange={(v) => onSelectWorktree(v === BASE ? '' : v)}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder={t('files.worktree.base')} />
          </SelectTrigger>
          <SelectContent position="popper">
            {worktrees.map((wt) => (
              <SelectItem key={wt.id || BASE} value={wt.id || BASE} className="text-xs">
                {worktreeLabel(wt)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {gitStatus && (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground" title={gitStatus.branch}>
          <GitBranch className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate font-mono">{gitStatus.branch}</span>
          {gitStatus.dirtyCount > 0 && (
            <span
              className={cn(
                'ml-auto shrink-0 rounded-full bg-warning/15 px-1.5 py-px font-medium text-warning-foreground',
              )}
              title={t('files.git.dirty', { count: gitStatus.dirtyCount })}
            >
              {gitStatus.dirtyCount}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
