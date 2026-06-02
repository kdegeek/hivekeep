import { createContext, useContext, type ReactNode } from 'react'
import { useTasks } from '@/client/hooks/useTasks'

type TasksContextValue = ReturnType<typeof useTasks>

const TasksContext = createContext<TasksContextValue | null>(null)

/**
 * Mounts a single `useTasks()` instance at the shell level and shares it.
 *
 * Tasks are now a first-class destination (the /tasks page) and several
 * always-present chrome elements need the live task state at once: the
 * ActivityBar badge, the mobile top-bar badge, and the QueueIndicator. Before
 * this provider each of those called `useTasks()` independently, multiplying
 * the initial REST fetch and the SSE-driven state. Hoisting to one provider
 * makes the task list a single source of truth across the app.
 */
export function TasksProvider({ children }: { children: ReactNode }) {
  const value = useTasks()
  return <TasksContext.Provider value={value}>{children}</TasksContext.Provider>
}

export function useTasksContext(): TasksContextValue {
  const ctx = useContext(TasksContext)
  if (!ctx) throw new Error('useTasksContext must be used within a <TasksProvider>')
  return ctx
}
