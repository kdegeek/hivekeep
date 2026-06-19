import { useState, useEffect, useCallback, useRef } from 'react'
import { api, getErrorMessage, ApiRequestError } from '@/client/lib/api'
import { useSSE } from '@/client/hooks/useSSE'
import { sourceApiBase, sourceQuery, sourceKey, changeMatchesSource } from '@/client/lib/workspace-source'
import type { WorkspaceChange } from '@/client/hooks/useWorkspaceFiles'
import type { WorkspaceFileInfo, WorkspaceSourceRef } from '@/shared/types'

/** Per-open-file state (files.md § 3.4/3.5). */
export interface TabFileState {
  info: WorkspaceFileInfo | null
  draft: string
  dirty: boolean
  /** 409 on save, or (P5) the agent rewrote the file while we were dirty. */
  conflict: boolean
  /** (P5) the file disappeared from disk while the tab was dirty. */
  deletedOnDisk: boolean
  isLoading: boolean
  isSaving: boolean
  error: string | null
}

interface PersistedTabs {
  tabs: string[]
  active: string | null
}

const storageKey = (source: WorkspaceSourceRef) => `files.tabs.${sourceKey(source)}`

const emptyState = (): TabFileState => ({
  info: null,
  draft: '',
  dirty: false,
  conflict: false,
  deletedOnDisk: false,
  isLoading: true,
  isSaving: false,
  error: null,
})

/**
 * Tab management for the Files section: light client-only tabs, dirty
 * tracking, optimistic-concurrency saves (409 → conflict banner) and
 * sessionStorage persistence per workspace. Unsaved CONTENT is deliberately
 * not persisted (files.md § 3.4) — a beforeunload guard covers the rest.
 */
export function useWorkspaceTabs(source: WorkspaceSourceRef | null) {
  const [tabs, setTabs] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [states, setStates] = useState<Record<string, TabFileState>>({})
  // Last (path, modifiedAt) we wrote — P5 uses it to ignore our own SSE echo.
  const lastSavedRef = useRef(new Map<string, number>())

  const patchState = useCallback((path: string, patch: Partial<TabFileState>) => {
    setStates((prev) => {
      const current = prev[path]
      if (!current) return prev
      return { ...prev, [path]: { ...current, ...patch } }
    })
  }, [])

  const loadFile = useCallback(
    async (path: string, opts: { keepDraft?: boolean } = {}) => {
      if (!source) return
      setStates((prev) => ({ ...prev, [path]: { ...(prev[path] ?? emptyState()), isLoading: true, error: null } }))
      try {
        const info = await api.get<WorkspaceFileInfo>(
          `${sourceApiBase(source)}/file${sourceQuery(source, { path })}`,
        )
        setStates((prev) => {
          const current = prev[path] ?? emptyState()
          return {
            ...prev,
            [path]: {
              ...current,
              info,
              draft: opts.keepDraft && current.dirty ? current.draft : (info.content ?? ''),
              dirty: opts.keepDraft ? current.dirty : false,
              conflict: false,
              deletedOnDisk: false,
              isLoading: false,
              error: null,
            },
          }
        })
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) {
          setStates((prev) => {
            const current = prev[path] ?? emptyState()
            return { ...prev, [path]: { ...current, isLoading: false, deletedOnDisk: true } }
          })
        } else {
          setStates((prev) => ({
            ...prev,
            [path]: { ...(prev[path] ?? emptyState()), isLoading: false, error: getErrorMessage(err) },
          }))
        }
      }
    },
    [source],
  )

  const openTab = useCallback(
    (path: string) => {
      setTabs((prev) => (prev.includes(path) ? prev : [...prev, path]))
      setActive(path)
      setStates((prev) => (prev[path] ? prev : { ...prev, [path]: emptyState() }))
      void loadFile(path)
    },
    [loadFile],
  )

  const focusTab = useCallback(
    (path: string) => {
      setActive(path)
      // Restored tabs are loaded lazily on first focus.
      setStates((prev) => {
        const current = prev[path]
        if (current && current.info === null && !current.isLoading && !current.error && !current.deletedOnDisk) {
          void loadFile(path)
        }
        return prev
      })
    },
    [loadFile],
  )

  /** Close without any dirty guard — the page confirms via UnsavedChangesDialog first. */
  const forceCloseTab = useCallback((path: string) => {
    setTabs((prev) => {
      const idx = prev.indexOf(path)
      const next = prev.filter((p) => p !== path)
      setActive((cur) => {
        if (cur !== path) return cur
        return next[Math.min(idx, next.length - 1)] ?? null
      })
      return next
    })
    setStates((prev) => {
      const next = { ...prev }
      delete next[path]
      return next
    })
  }, [])

  const updateDraft = useCallback(
    (path: string, value: string) => {
      setStates((prev) => {
        const current = prev[path]
        if (!current || !current.info) return prev
        return {
          ...prev,
          [path]: { ...current, draft: value, dirty: value !== (current.info.content ?? '') },
        }
      })
    },
    [],
  )

  const save = useCallback(
    async (path: string, opts: { force?: boolean } = {}) => {
      if (!source) return
      const state = states[path]
      if (!state?.info) return
      patchState(path, { isSaving: true, error: null })
      try {
        const result = await api.put<{ path: string; size: number; modifiedAt: number }>(
          `${sourceApiBase(source)}/file${sourceQuery(source)}`,
          {
            path,
            content: state.draft,
            // force (overwrite after conflict / recreate after delete) omits the base mtime
            ...(opts.force || state.deletedOnDisk ? {} : { baseModifiedAt: state.info.modifiedAt }),
          },
        )
        lastSavedRef.current.set(path, result.modifiedAt)
        setStates((prev) => {
          const current = prev[path]
          if (!current?.info) return prev
          return {
            ...prev,
            [path]: {
              ...current,
              info: { ...current.info, content: current.draft, size: result.size, modifiedAt: result.modifiedAt },
              dirty: false,
              conflict: false,
              deletedOnDisk: false,
              isSaving: false,
            },
          }
        })
      } catch (err) {
        if (err instanceof ApiRequestError && err.code === 'CONFLICT') {
          patchState(path, { isSaving: false, conflict: true })
        } else {
          patchState(path, { isSaving: false, error: getErrorMessage(err) })
        }
      }
    },
    [source, states, patchState],
  )

  /** Rename `from` → `to` across tabs/states/active, draft preserved. */
  const retargetTabs = useCallback((from: string, to: string, isDirectory: boolean) => {
    const map = (p: string) =>
      p === from ? to : isDirectory && p.startsWith(from + '/') ? to + p.slice(from.length) : p
    setTabs((prev) => prev.map(map))
    setActive((cur) => (cur ? map(cur) : cur))
    setStates((prev) => {
      const next: Record<string, TabFileState> = {}
      for (const [path, state] of Object.entries(prev)) {
        const newPath = map(path)
        next[newPath] =
          newPath === path || !state.info ? state : { ...state, info: { ...state.info, path: newPath } }
      }
      return next
    })
  }, [])

  // Live reconciliation with agent writes (files.md § 8.2). The (path,
  // modifiedAt) pair memorized at save time identifies our own echo.
  const statesRef = useRef(states)
  statesRef.current = states
  useSSE({
    'workspace:changed': (data) => {
      if (!source || !changeMatchesSource(data as { agentId?: string; source?: WorkspaceSourceRef }, source)) return
      for (const change of (data.changes as WorkspaceChange[]) ?? []) {
        const affected = (path: string) =>
          path === change.path || (change.isDirectory && path.startsWith(change.path + '/'))
        if (change.type === 'renamed' && change.newPath) {
          retargetTabs(change.path, change.newPath, change.isDirectory)
          continue
        }
        for (const path of Object.keys(statesRef.current)) {
          if (!affected(path)) continue
          const state = statesRef.current[path]!
          if (change.type === 'deleted') {
            if (state.dirty) patchState(path, { deletedOnDisk: true })
            else forceCloseTab(path)
          } else if (change.type === 'modified' || change.type === 'created') {
            // Own echo: the PUT response already updated this tab.
            if (change.modifiedAt !== undefined && lastSavedRef.current.get(path) === change.modifiedAt) continue
            if (state.dirty) patchState(path, { conflict: true })
            else if (state.info || state.deletedOnDisk) void loadFile(path)
          }
        }
      }
    },
  })

  const anyDirty = Object.values(states).some((s) => s.dirty)

  // beforeunload guard: unsaved content is not persisted anywhere.
  useEffect(() => {
    if (!anyDirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [anyDirty])

  // Persist open tab paths per source (sessionStorage, content excluded).
  const restoredForSource = useRef<string | null>(null)
  const key = source ? sourceKey(source) : null
  useEffect(() => {
    if (!source || !key) return
    if (restoredForSource.current === key) return
    restoredForSource.current = key
    setStates({})
    try {
      const raw = sessionStorage.getItem(storageKey(source))
      const persisted = raw ? (JSON.parse(raw) as PersistedTabs) : null
      const restoredTabs = persisted?.tabs ?? []
      setTabs(restoredTabs)
      setStates(Object.fromEntries(restoredTabs.map((p) => [p, { ...emptyState(), isLoading: false }])))
      const restoredActive = persisted?.active && restoredTabs.includes(persisted.active) ? persisted.active : null
      setActive(restoredActive)
      if (restoredActive) void loadFile(restoredActive)
    } catch {
      setTabs([])
      setActive(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, loadFile])

  useEffect(() => {
    if (!source || !key || restoredForSource.current !== key) return
    sessionStorage.setItem(storageKey(source), JSON.stringify({ tabs, active } satisfies PersistedTabs))
  }, [source, key, tabs, active])

  return {
    tabs,
    active,
    states,
    anyDirty,
    openTab,
    focusTab,
    forceCloseTab,
    updateDraft,
    save,
    reload: loadFile,
    setStates,
    lastSavedRef,
  }
}
