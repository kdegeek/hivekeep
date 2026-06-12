import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/client/components/ui/select'
import { AgentSelectItem, type AgentOption } from '@/client/components/common/AgentSelectItem'

interface AgentSelectorProps {
  /** Currently selected agent id */
  value: string
  /** Callback when selection changes */
  onValueChange: (value: string) => void
  /** List of agents to choose from */
  agents: AgentOption[]
  /** Placeholder text when nothing is selected */
  placeholder?: string
  /** Whether the field is required */
  required?: boolean
  /** Optional "none" option label — if set, adds a none/empty option at the top */
  noneLabel?: string
  /** Value used for the "none" option (default: "none") */
  noneValue?: string
  /** Custom className for the trigger */
  triggerClassName?: string
  /** If true, the trigger auto-sizes height for the avatar row */
  autoHeight?: boolean
}

export function AgentSelector({
  value,
  onValueChange,
  agents,
  placeholder = '',
  required,
  noneLabel,
  noneValue = 'none',
  triggerClassName,
  autoHeight = true,
}: AgentSelectorProps) {
  const selectedAgent = agents.find((k) => k.id === value)
  const isNone = !value || value === noneValue

  return (
    <Select value={value} onValueChange={onValueChange} required={required}>
      <SelectTrigger className={triggerClassName ?? (autoHeight ? 'w-full h-auto min-h-9' : undefined)}>
        {!isNone && selectedAgent ? (
          <AgentSelectItem agent={selectedAgent} />
        ) : (
          <SelectValue placeholder={placeholder} />
        )}
      </SelectTrigger>
      <SelectContent position="popper">
        {noneLabel != null && <SelectItem value={noneValue}>{noneLabel}</SelectItem>}
        {agents.map((agent) => (
          <SelectItem key={agent.id} value={agent.id} className="py-2">
            <AgentSelectItem agent={agent} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
