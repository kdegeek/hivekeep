import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, ChevronUp, Loader2, Square, X, ListChecks } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import type { TaskTodo, TaskTodoStatus } from '@/shared/types'

interface TaskTodoListProps {
  todos: TaskTodo[]
}

function statusIcon(status: TaskTodoStatus) {
  switch (status) {
    case 'completed':
      return <Check className="size-3.5 text-success" />
    case 'in_progress':
      return <Loader2 className="size-3.5 animate-spin text-primary" />
    case 'cancelled':
      return <X className="size-3.5 text-muted-foreground" />
    default:
      return <Square className="size-3.5 text-muted-foreground" />
  }
}

function rowClasses(status: TaskTodoStatus): string {
  switch (status) {
    case 'completed':
      return 'text-muted-foreground line-through'
    case 'in_progress':
      return 'text-foreground font-medium'
    case 'cancelled':
      return 'text-muted-foreground/70 line-through opacity-70'
    default:
      return 'text-foreground/90'
  }
}

/**
 * Compact banner the sub-Agent's `task_todos` plan: a single line by default
 * showing `(done/total) <current step>`. Clicking expands into a full
 * checklist in-place — no inner side panel — so it stays inside the task
 * panel's existing horizontal real estate.
 */
export const TaskTodoList = memo(function TaskTodoList({ todos }: TaskTodoListProps) {
  const { t } = useTranslation()
  const completed = todos.filter((t) => t.status === 'completed').length
  const inProgress = todos.find((t) => t.status === 'in_progress')
  const fallback = todos.find((t) => t.status === 'pending') ?? todos[todos.length - 1]
  const currentLine = inProgress ?? fallback
  const total = todos.length
  const [expanded, setExpanded] = useState(false)
  const allDone = total > 0 && completed === total

  return (
    <section className="shrink-0 border-b border-border bg-muted/20">
      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={expanded}
        aria-label={t('taskDetail.todos.toggle')}
      >
        <ListChecks className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 tabular-nums text-muted-foreground">
          ({completed}/{total})
        </span>
        {currentLine ? (
          <span className="flex flex-1 min-w-0 items-center gap-1.5">
            {inProgress ? (
              <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
            ) : allDone ? (
              <Check className="size-3 shrink-0 text-success" />
            ) : (
              <Square className="size-3 shrink-0 text-muted-foreground" />
            )}
            <span className={cn('truncate', inProgress ? 'text-foreground' : 'text-muted-foreground')}>
              {currentLine.subject}
            </span>
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {expanded
          ? <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
          : <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />}
      </button>

      {expanded && (
        <ol className="max-h-[40vh] overflow-y-auto px-3 pb-2 pt-0.5 space-y-1">
          {todos.map((todo) => (
            <li
              key={todo.id}
              className={cn('flex items-start gap-2 text-xs leading-snug', rowClasses(todo.status))}
            >
              <span className="shrink-0 mt-0.5">{statusIcon(todo.status)}</span>
              <span className="flex-1 min-w-0 whitespace-pre-wrap break-words">{todo.subject}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
})
