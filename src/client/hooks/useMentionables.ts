import { useState, useEffect } from 'react'
import { api } from '@/client/lib/api'

export interface MentionableUser {
  id: string
  pseudonym: string
  firstName: string
  avatarUrl: string | null
}

export interface MentionableAgent {
  id: string
  slug: string | null
  name: string
  avatarUrl: string | null
}

export interface Mentionables {
  users: MentionableUser[]
  agents: MentionableAgent[]
}

/**
 * Fetch the combined list of users and agents for @mention autocomplete.
 * Fetches once on mount.
 */
export function useMentionables() {
  const [data, setData] = useState<Mentionables>({ users: [], agents: [] })
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    api.get('/users/mentionables')
      .then((res) => {
        if (!cancelled) {
          setData(res as Mentionables)
          setIsLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => { cancelled = true }
  }, [])

  return { ...data, isLoading }
}
