import { createContext, useContext, useMemo } from 'react'
import type { MentionableUser, MentionableAgent } from '@/client/hooks/useMentionables'

interface MentionLookup {
  /** Set of lowercase pseudonyms (users) */
  userHandles: Set<string>
  /** Set of lowercase slugs/names (agents) */
  agentHandles: Set<string>
}

const MentionContext = createContext<MentionLookup>({
  userHandles: new Set(),
  agentHandles: new Set(),
})

export function MentionLookupProvider({
  users,
  agents,
  children,
}: {
  users: MentionableUser[]
  agents: MentionableAgent[]
  children: React.ReactNode
}) {
  const lookup = useMemo<MentionLookup>(() => {
    const userHandles = new Set(users.map((u) => u.pseudonym.toLowerCase()))
    const agentHandles = new Set<string>()
    for (const k of agents) {
      if (k.slug) agentHandles.add(k.slug.toLowerCase())
      agentHandles.add(k.name.toLowerCase())
    }
    return { userHandles, agentHandles }
  }, [users, agents])

  return (
    <MentionContext.Provider value={lookup}>
      {children}
    </MentionContext.Provider>
  )
}

export function useMentionLookup() {
  return useContext(MentionContext)
}
