/**
 * Glue between the URL/Agent list and the TicketMentionProvider.
 *
 * The provider needs an "active project id" to resolve bare `#N` mentions.
 * That id depends on context:
 *
 *   - Inside an Agent chat (`/agent/:slug`): the agent's `activeProjectId`.
 *   - Inside a project page (`/projects/:projectId`): the project id itself.
 *   - Elsewhere: null (bare refs will surface as `NO_ACTIVE_PROJECT`).
 *
 * Putting this resolution next to the provider keeps the rest of the app
 * agnostic — markdown renderers anywhere call `useTicketMention(raw)` and the
 * project context is figured out here.
 */
import { type ReactNode } from 'react'
import { useLocation, useMatch } from 'react-router-dom'
import { useAgentList } from '@/client/hooks/useAgentList'
import { TicketMentionProvider } from '@/client/contexts/TicketMentionContext'

export function TicketMentionShell({ children }: { children: ReactNode }) {
  const location = useLocation()
  const projectMatch = useMatch('/projects/:projectId')
  const { agents } = useAgentList()

  // Match `/agent/:slug` from the path manually since the routing config uses a
  // catch-all `*` for the chat page rather than a typed route.
  const agentSlugMatch = location.pathname.match(/^\/agent\/([^/]+)/)
  const agentSlug = agentSlugMatch?.[1] ?? null

  let activeProjectId: string | null = null
  if (projectMatch?.params.projectId) {
    activeProjectId = projectMatch.params.projectId
  } else if (agentSlug) {
    const agent = agents.find((k) => k.slug === agentSlug)
    activeProjectId = agent?.activeProjectId ?? null
  }

  return (
    <TicketMentionProvider activeProjectId={activeProjectId}>{children}</TicketMentionProvider>
  )
}
