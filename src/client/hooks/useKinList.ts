import { useState, useEffect, useCallback } from 'react'
import { api } from '@/client/lib/api'
import { useSSE } from '@/client/hooks/useSSE'

export interface KinListItem {
  id: string
  slug?: string
  name: string
  role?: string
  avatarUrl: string | null
  activeProjectId?: string | null
}

/**
 * Lightweight hook to fetch the kin list for selectors and display.
 * Unlike the full `useKins` hook, this doesn't include ordering, CRUD, or models.
 * Use this in settings pages that just need a kin list for dropdowns or name/avatar display.
 *
 * Listens to `kin:active-project` so consumers (e.g. project avatars stack) reflect
 * project-activation changes live.
 */
export function useKinList() {
  const [kins, setKins] = useState<KinListItem[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const fetchKins = useCallback(async () => {
    try {
      const data = await api.get<{ kins: KinListItem[] }>('/kins')
      setKins(data.kins)
    } catch {
      // Ignore errors
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchKins()
  }, [fetchKins])

  // Keep activeProjectId in sync without a full refetch
  useSSE({
    'kin:active-project': (data) => {
      const kinId = data.kinId as string
      const activeProjectId = (data.activeProjectId as string | null) ?? null
      setKins((prev) => prev.map((k) => (k.id === kinId ? { ...k, activeProjectId } : k)))
    },
  })

  /** Map of kinId → name */
  const kinNames = new Map(kins.map((k) => [k.id, k.name]))

  /** Map of kinId → avatarUrl */
  const kinAvatars = new Map(kins.map((k) => [k.id, k.avatarUrl]))

  return { kins, kinNames, kinAvatars, isLoading, refetch: fetchKins }
}
