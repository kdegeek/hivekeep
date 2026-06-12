import { useState, useEffect, useCallback, useRef } from 'react'
import { api, getErrorMessage } from '@/client/lib/api'
import { useSSE, useSSEResync } from '@/client/hooks/useSSE'
import type { WorkspaceEntry } from '@/shared/types'

/** Payload of the workspace:changed SSE event (files.md § 8.1). */
export interface WorkspaceChange {
  path: string
  type: 'created' | 'modified' | 'deleted' | 'renamed'
  isDirectory: boolean
  newPath?: string
  modifiedAt?: number
}

/** Parent dir of a workspace-relative path ('' = root). */
export const parentDirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/**
 * App-level clipboard for workspace entries (files.md § 4.3) — survives
 * workspace switches so cross-workspace copy/paste works. Never touches the
 * OS clipboard (a server file cannot live there).
 */
export interface WorkspaceClipboard {
  agentId: string
  path: string
  isDirectory: boolean
  op: 'copy' | 'cut'
}
let clipboardValue: WorkspaceClipboard | null = null
const clipboardListeners = new Set<() => void>()
export function setWorkspaceClipboard(value: WorkspaceClipboard | null) {
  clipboardValue = value
  for (const listener of clipboardListeners) listener()
}
export function getWorkspaceClipboard() {
  return clipboardValue
}
export function useWorkspaceClipboard(): WorkspaceClipboard | null {
  const [value, setValue] = useState(clipboardValue)
  useEffect(() => {
    const listener = () => setValue(clipboardValue)
    clipboardListeners.add(listener)
    return () => {
      clipboardListeners.delete(listener)
    }
  }, [])
  return value
}

/** Loading state of one lazily-fetched directory of the workspace tree. */
export interface WorkspaceDirState {
  entries: WorkspaceEntry[] | null
  isLoading: boolean
  error: string | null
}

interface LsResponse {
  path: string
  entries: WorkspaceEntry[]
}

/**
 * Workspace tree state for the Files section (files.md § 3.3): directories are
 * fetched lazily on expansion, refetched on resume (SSE has no replay), and
 * patched live by `workspace:changed` (wired in P5).
 */
export function useWorkspaceFiles(agentId: string | null) {
  // Keyed by dir path ('' = workspace root).
  const [dirs, setDirs] = useState<Record<string, WorkspaceDirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // Guards against out-of-order responses after rapid agent switches.
  const generationRef = useRef(0)

  const loadDir = useCallback(
    async (path: string) => {
      if (!agentId) return
      const generation = generationRef.current
      setDirs((prev) => ({
        ...prev,
        [path]: { entries: prev[path]?.entries ?? null, isLoading: true, error: null },
      }))
      try {
        const data = await api.get<LsResponse>(
          `/agents/${encodeURIComponent(agentId)}/workspace/ls?path=${encodeURIComponent(path)}`,
        )
        if (generation !== generationRef.current) return
        setDirs((prev) => ({ ...prev, [path]: { entries: data.entries, isLoading: false, error: null } }))
      } catch (err) {
        if (generation !== generationRef.current) return
        setDirs((prev) => ({
          ...prev,
          [path]: { entries: prev[path]?.entries ?? null, isLoading: false, error: getErrorMessage(err) },
        }))
      }
    },
    [agentId],
  )

  const toggleDir = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
          // (Re)fetch on every expansion: shell-driven agent writes emit no SSE,
          // so expansion is one of the freshness fallbacks (files.md § 8.1).
          void loadDir(path)
        }
        return next
      })
    },
    [loadDir],
  )

  /** Expand every ancestor directory of `path` (deep links, reveal-in-tree). */
  const expandTo = useCallback(
    (path: string) => {
      const parts = path.split('/').filter(Boolean)
      const ancestors: string[] = []
      for (let i = 0; i < parts.length - 1; i++) ancestors.push(parts.slice(0, i + 1).join('/'))
      setExpanded((prev) => {
        const next = new Set(prev)
        for (const dir of ancestors) next.add(dir)
        return next
      })
      for (const dir of ancestors) void loadDir(dir)
    },
    [loadDir],
  )

  /** Refetch the root and every expanded directory (refresh button / resume). */
  const refresh = useCallback(() => {
    if (!agentId) return
    void loadDir('')
    for (const dir of expanded) void loadDir(dir)
  }, [agentId, loadDir, expanded])

  // Reset and reload when switching workspaces.
  useEffect(() => {
    generationRef.current++
    setDirs({})
    setExpanded(new Set())
    if (agentId) void loadDir('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId])

  // SSE has no event replay: refetch visible state on tab resume / reconnect.
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useSSEResync(() => refreshRef.current())

  // ── Live tree patching from workspace:changed (files.md § 8.2) ─────────────
  // Idempotent by path (insert-if-absent / remove-if-present / tolerant rename)
  // so the emitter's own optimistic update double-applies harmlessly.

  const sortEntries = (entries: WorkspaceEntry[]) =>
    [...entries].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })

  const applyChange = useCallback(
    (change: WorkspaceChange) => {
      const parent = parentDirOf(change.path)
      const name = change.path.split('/').pop() ?? change.path
      if (change.type === 'created' || (change.type === 'modified' && !change.isDirectory)) {
        setDirs((prev) => {
          const state = prev[parent]
          if (!state?.entries) return prev // parent not loaded: it'll fetch on expand
          const existing = state.entries.find((e) => e.path === change.path)
          const entry: WorkspaceEntry = existing
            ? { ...existing, modifiedAt: change.modifiedAt ?? existing.modifiedAt }
            : {
                name,
                path: change.path,
                type: change.isDirectory ? 'dir' : 'file',
                size: 0,
                modifiedAt: change.modifiedAt ?? 0,
                isSymlink: false,
              }
          const entries = sortEntries([...state.entries.filter((e) => e.path !== change.path), entry])
          return { ...prev, [parent]: { ...state, entries } }
        })
      } else if (change.type === 'modified' && change.isDirectory) {
        // Coarse event (recursive op): refetch the folder if we have it loaded.
        setDirs((prev) => {
          if (prev[change.path]?.entries) void loadDir(change.path)
          else if (prev[parent]?.entries) void loadDir(parent)
          return prev
        })
      } else if (change.type === 'deleted') {
        setDirs((prev) => {
          const next = { ...prev }
          const state = next[parent]
          if (state?.entries) {
            next[parent] = { ...state, entries: state.entries.filter((e) => e.path !== change.path) }
          }
          if (change.isDirectory) {
            for (const key of Object.keys(next)) {
              if (key === change.path || key.startsWith(change.path + '/')) delete next[key]
            }
          }
          return next
        })
        setExpanded((prev) => {
          if (!change.isDirectory) return prev
          const next = new Set([...prev].filter((p) => p !== change.path && !p.startsWith(change.path + '/')))
          return next.size === prev.size ? prev : next
        })
      } else if (change.type === 'renamed' && change.newPath) {
        const newPath = change.newPath
        const newParent = parentDirOf(newPath)
        const newName = newPath.split('/').pop() ?? newPath
        setDirs((prev) => {
          const next = { ...prev }
          const oldState = next[parent]
          if (oldState?.entries) {
            next[parent] = { ...oldState, entries: oldState.entries.filter((e) => e.path !== change.path) }
          }
          if (change.isDirectory) {
            // Re-key the loaded subtree (and fix child entry paths lazily via refetch).
            for (const key of Object.keys(next)) {
              if (key === change.path || key.startsWith(change.path + '/')) {
                delete next[key]
              }
            }
          }
          const destState = next[newParent]
          if (destState?.entries) {
            const entry: WorkspaceEntry = {
              name: newName,
              path: newPath,
              type: change.isDirectory ? 'dir' : 'file',
              size: 0,
              modifiedAt: change.modifiedAt ?? 0,
              isSymlink: false,
            }
            next[newParent] = {
              ...destState,
              entries: sortEntries([...destState.entries.filter((e) => e.path !== newPath), entry]),
            }
          }
          return next
        })
        setExpanded((prev) => {
          if (!change.isDirectory) return prev
          const next = new Set<string>()
          for (const p of prev) {
            if (p === change.path) next.add(newPath)
            else if (p.startsWith(change.path + '/')) next.add(newPath + p.slice(change.path.length))
            else next.add(p)
          }
          return next
        })
      }
    },
    [loadDir],
  )

  useSSE({
    'workspace:changed': (data) => {
      if ((data.agentId as string) !== agentId) return
      for (const change of (data.changes as WorkspaceChange[]) ?? []) applyChange(change)
    },
  })

  // ── Mutations (files.md § 4/6.5/6.6) — each reloads the affected dirs ──────

  const base = useCallback(
    () => `/agents/${encodeURIComponent(agentId ?? '')}/workspace`,
    [agentId],
  )

  const createFile = useCallback(
    async (dirPath: string, name: string): Promise<string> => {
      const path = dirPath ? `${dirPath}/${name}` : name
      await api.put(`${base()}/file`, { path, content: '', createOnly: true })
      await loadDir(dirPath)
      return path
    },
    [base, loadDir],
  )

  const createDir = useCallback(
    async (dirPath: string, name: string): Promise<string> => {
      const path = dirPath ? `${dirPath}/${name}` : name
      await api.post(`${base()}/mkdir`, { path })
      await loadDir(dirPath)
      return path
    },
    [base, loadDir],
  )

  const movePath = useCallback(
    async (from: string, to: string, fromAgentId?: string): Promise<string> => {
      const result = await api.post<{ from: string; to: string }>(`${base()}/move`, { from, to, fromAgentId })
      await loadDir(parentDirOf(to))
      if (!fromAgentId || fromAgentId === agentId) await loadDir(parentDirOf(from))
      return result.to
    },
    [base, loadDir, agentId],
  )

  const copyPath = useCallback(
    async (from: string, to: string, fromAgentId?: string): Promise<string> => {
      const result = await api.post<{ from: string; to: string }>(`${base()}/copy`, { from, to, fromAgentId })
      await loadDir(parentDirOf(result.to))
      return result.to
    },
    [base, loadDir],
  )

  const removePath = useCallback(
    async (path: string): Promise<void> => {
      await api.delete(`${base()}/file?path=${encodeURIComponent(path)}`)
      await loadDir(parentDirOf(path))
    },
    [base, loadDir],
  )

  const uploadFiles = useCallback(
    async (dirPath: string, files: File[]): Promise<{ files: Array<{ path: string }>; errors: Array<{ name: string; code: string }> }> => {
      // Raw fetch: the shared api helper JSON-encodes bodies (multipart needs
      // the browser-set boundary header) — same pattern as useFileUpload.
      const formData = new FormData()
      formData.append('path', dirPath)
      for (const file of files) formData.append('file', file)
      const res = await fetch(`/api${base()}/upload`, { method: 'POST', credentials: 'include', body: formData })
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
        throw new Error(data?.error?.message ?? 'Upload failed')
      }
      const result = (await res.json()) as { files: Array<{ path: string }>; errors: Array<{ name: string; code: string }> }
      await loadDir(dirPath)
      return result
    },
    [base, loadDir],
  )

  return {
    dirs,
    expanded,
    loadDir,
    toggleDir,
    expandTo,
    refresh,
    setDirs,
    createFile,
    createDir,
    movePath,
    copyPath,
    removePath,
    uploadFiles,
  }
}
