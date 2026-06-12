import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AgentCard, type AgentCardProps } from '@/client/components/agent/AgentCard'

type SortableAgentCardProps = Omit<AgentCardProps, 'dragHandleProps' | 'isDragging' | 'style'>

export function SortableAgentCard(props: SortableAgentCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
  }

  return (
    <AgentCard
      ref={setNodeRef}
      style={style}
      isDragging={isDragging}
      dragHandleProps={{ ...attributes, ...listeners }}
      {...props}
    />
  )
}
