import { Avatar, AvatarFallback, AvatarImage } from '@/client/components/ui/avatar'

export interface AgentOption {
  id: string
  name: string
  role?: string
  avatarUrl?: string | null
}

export function AgentSelectItem({ agent }: { agent: AgentOption }) {
  const initials = agent.name.slice(0, 2).toUpperCase()
  return (
    <div className="flex items-center gap-2.5 min-w-0 text-left">
      <Avatar className="size-6 shrink-0">
        {agent.avatarUrl && <AvatarImage src={agent.avatarUrl} alt={agent.name} />}
        <AvatarFallback className="text-[9px] bg-secondary">{initials}</AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <span className="block truncate text-sm">{agent.name}</span>
        {agent.role && (
          <span className="block truncate text-[10px] text-muted-foreground leading-tight">
            {agent.role}
          </span>
        )}
      </div>
    </div>
  )
}
