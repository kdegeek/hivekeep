import { createContext, useContext, type ReactNode } from 'react'
import { useCrons } from '@/client/hooks/useCrons'

type CronsContextValue = ReturnType<typeof useCrons>

const CronsContext = createContext<CronsContextValue | null>(null)

/**
 * Mounts a single `useCrons()` instance at the shell level and shares it.
 *
 * Mirrors `TasksProvider`: several always-present chrome elements need the live
 * cron state at once — the ActivityBar badge and the mobile top-bar badge (both
 * highlight agent-created crons awaiting approval) plus the /crons page itself.
 * Hoisting to one provider keeps a single source of truth and avoids each
 * consumer re-running the initial REST fetch and SSE subscriptions.
 */
export function CronsProvider({ children }: { children: ReactNode }) {
  const value = useCrons()
  return <CronsContext.Provider value={value}>{children}</CronsContext.Provider>
}

export function useCronsContext(): CronsContextValue {
  const ctx = useContext(CronsContext)
  if (!ctx) throw new Error('useCronsContext must be used within a <CronsProvider>')
  return ctx
}
