import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/client/components/ui/tooltip'
import { useAgentList } from '@/client/hooks/useAgentList'
import { cn } from '@/client/lib/utils'

interface ActiveAgentsIndicatorProps {
  projectId: string
  /** Max avatars shown stacked before collapsing into a +N badge. Default: 3 */
  maxVisible?: number
  /** Avatar size token. Default: "size-5" */
  size?: string
  className?: string
  /** When true (default), clicking an avatar navigates to that Agent's chat thread. */
  clickable?: boolean
}

/**
 * Renders a stacked-avatar row of Agents that currently have this project as
 * their active_project_id. Used in the projects sidebar entry and in the
 * kanban header so it's always visible *who* is currently focused on the
 * project. Clicking an avatar jumps to that Agent's thread.
 */
export function ActiveAgentsIndicator({
  projectId,
  maxVisible = 3,
  size = 'size-5',
  className,
  clickable = true,
}: ActiveAgentsIndicatorProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { agents } = useAgentList()

  const activeAgents = agents.filter((k) => k.activeProjectId === projectId)
  if (activeAgents.length === 0) return null

  const visible = activeAgents.slice(0, maxVisible)
  const overflow = activeAgents.length - visible.length

  return (
    <div
      className={cn('flex items-center -space-x-1.5', className)}
      onClick={(e) => e.stopPropagation()}
    >
      {visible.map((agent) => {
        const initials = agent.name.slice(0, 2).toUpperCase()
        const target = agent.slug ? `/agent/${agent.slug}` : '/'
        const inner = (
          <Avatar
            className={cn(
              size,
              'ring-2 ring-background transition-transform',
              clickable && 'cursor-pointer hover:translate-y-[-1px] hover:ring-primary',
            )}
          >
            {agent.avatarUrl && <AvatarImage src={agent.avatarUrl} alt={agent.name} />}
            <AvatarFallback className="text-[9px] bg-secondary">{initials}</AvatarFallback>
          </Avatar>
        )
        return (
          <Tooltip key={agent.id}>
            <TooltipTrigger asChild>
              {clickable ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    navigate(target)
                  }}
                  className="rounded-full"
                  aria-label={t('projects.activeAgents.openThread', { name: agent.name })}
                >
                  {inner}
                </button>
              ) : (
                <span>{inner}</span>
              )}
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <span className="text-xs">
                {t('projects.activeAgents.tooltip', { name: agent.name })}
              </span>
            </TooltipContent>
          </Tooltip>
        )
      })}
      {overflow > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                size,
                'inline-flex items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-2 ring-background',
              )}
            >
              +{overflow}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <span className="text-xs">
              {activeAgents.slice(maxVisible).map((k) => k.name).join(', ')}
            </span>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
