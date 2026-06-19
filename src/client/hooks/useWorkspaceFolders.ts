import { useState, useEffect, useCallback } from 'react'
import { api } from '@/client/lib/api'
import type { WorkspaceFolderDTO } from '@/shared/types'

/**
 * User-added arbitrary FS folders shown in the Files selector. Folders rarely
 * change, so this just fetches once and patches optimistically on add/remove
 * (no SSE channel in v1).
 */
export function useWorkspaceFolders() {
  const [folders, setFolders] = useState<WorkspaceFolderDTO[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const reload = useCallback(async () => {
    try {
      const data = await api.get<{ folders: WorkspaceFolderDTO[] }>('/workspace-folders')
      setFolders(data.folders)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const create = useCallback(async (label: string, path: string): Promise<WorkspaceFolderDTO> => {
    const { folder } = await api.post<{ folder: WorkspaceFolderDTO }>('/workspace-folders', { label, path })
    setFolders((prev) => [...prev, folder])
    return folder
  }, [])

  const remove = useCallback(async (id: string): Promise<void> => {
    await api.delete(`/workspace-folders/${id}`)
    setFolders((prev) => prev.filter((f) => f.id !== id))
  }, [])

  return { folders, isLoading, reload, create, remove }
}
