import { useCallback, useEffect, useState } from 'react'
import { isDesktopRuntime } from '@/client/lib/api'

function hasTauriBridge(): boolean {
  return typeof window !== 'undefined' &&
    Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
}

export type DesktopUpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'restarting' | 'error'

export interface DesktopUpdateState {
  status: DesktopUpdateStatus
  version: string | null
  body: string | null
  /** 0-100, undefined while the download hasn't reported a content length yet. */
  progress: number | undefined
  error: string | null
}

const IDLE_STATE: DesktopUpdateState = { status: 'idle', version: null, body: null, progress: undefined, error: null }

/**
 * Checks for and applies updates to the desktop binary itself via Tauri's
 * updater plugin — distinct from the web/Docker server-update flow in
 * UpdateContext, which only ever updates the server the browser talks to and
 * has no way to replace a bundled desktop installer. No-ops outside the
 * desktop shell (real Tauri runtime required, not just a desktop build flag).
 */
export function useDesktopUpdater() {
  const [state, setState] = useState<DesktopUpdateState>(IDLE_STATE)

  const checkForUpdate = useCallback(async () => {
    if (!isDesktopRuntime() || !hasTauriBridge()) return
    setState((s) => ({ ...s, status: 'checking', error: null }))
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()
      if (!update) {
        setState(IDLE_STATE)
        return
      }
      setState({ status: 'available', version: update.version, body: update.body ?? null, progress: undefined, error: null })
    } catch (err) {
      setState({ status: 'error', version: null, body: null, progress: undefined, error: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  const startUpdate = useCallback(async () => {
    if (!isDesktopRuntime() || !hasTauriBridge()) return
    setState((s) => ({ ...s, status: 'downloading', progress: 0 }))
    try {
      const [{ check }, { relaunch }] = await Promise.all([
        import('@tauri-apps/plugin-updater'),
        import('@tauri-apps/plugin-process'),
      ])
      const update = await check()
      if (!update) {
        setState(IDLE_STATE)
        return
      }

      let contentLength = 0
      let downloaded = 0
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          contentLength = event.data.contentLength ?? 0
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength
          setState((s) => ({
            ...s,
            progress: contentLength > 0 ? Math.min(100, Math.round((downloaded / contentLength) * 100)) : undefined,
          }))
        }
      })

      setState((s) => ({ ...s, status: 'restarting', progress: 100 }))
      await relaunch()
    } catch (err) {
      setState((s) => ({
        ...s,
        status: 'error',
        progress: undefined,
        error: err instanceof Error ? err.message : String(err),
      }))
    }
  }, [])

  const dismiss = useCallback(() => setState(IDLE_STATE), [])

  // Check once on launch.
  useEffect(() => {
    void checkForUpdate()
  }, [checkForUpdate])

  return { state, checkForUpdate, startUpdate, dismiss }
}
