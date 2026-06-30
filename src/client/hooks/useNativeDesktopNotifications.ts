import { useCallback, useEffect, useRef } from 'react'
import { api, isDesktopRuntime } from '@/client/lib/api'
import { useSSE, useSSEResync } from '@/client/hooks/useSSE'
import type { NotificationSummary } from '@/shared/types'

const MAX_DELIVERED_IDS = 200
const DELIVERED_STORAGE_KEY = 'hivekeep:nativeDesktopDeliveredNotificationIds'
const CATCH_UP_LIMIT = 10

interface NotificationsResponse {
  notifications: NotificationSummary[]
}

function hasTauriBridge(): boolean {
  return typeof window !== 'undefined' &&
    Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
}

function isNativeDesktopRuntime(): boolean {
  return isDesktopRuntime() && hasTauriBridge()
}

function readDeliveredIds(): Set<string> {
  try {
    const raw = localStorage.getItem(DELIVERED_STORAGE_KEY)
    const ids = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeDeliveredIds(ids: Set<string>): void {
  try {
    localStorage.setItem(DELIVERED_STORAGE_KEY, JSON.stringify([...ids].slice(-MAX_DELIVERED_IDS)))
  } catch {
    // Notification delivery is best-effort; storage failures should not break the app.
  }
}

function notificationBody(notification: NotificationSummary): string {
  return notification.body ?? notification.agentName ?? 'New Hivekeep notification'
}

/**
 * Fires a native Windows toast for new notifications while the main window
 * isn't focused — e.g. a background agent task finishing while Hivekeep is
 * minimized to the tray. Reuses the same `notification:new` SSE event and
 * `/notifications` catch-up the web/mobile notification center is built on,
 * so "what counts as notification-worthy" stays defined once, server-side.
 *
 * No-ops entirely outside the desktop shell.
 */
export function useNativeDesktopNotifications(): void {
  const deliveredIdsRef = useRef<Set<string>>(readDeliveredIds())
  const focusedRef = useRef(true)
  const permissionGrantedRef = useRef<boolean | null>(null)

  const deliver = useCallback(async (notification: NotificationSummary) => {
    if (!isNativeDesktopRuntime()) return
    if (focusedRef.current) return
    if (deliveredIdsRef.current.has(notification.id)) return

    if (permissionGrantedRef.current === null) {
      const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification')
      permissionGrantedRef.current = (await isPermissionGranted()) || (await requestPermission() === 'granted')
    }
    if (!permissionGrantedRef.current) return

    const { sendNotification } = await import('@tauri-apps/plugin-notification')
    sendNotification({ title: notification.title, body: notificationBody(notification) })

    const deliveredIds = deliveredIdsRef.current
    deliveredIds.add(notification.id)
    if (deliveredIds.size > MAX_DELIVERED_IDS) {
      const retained = [...deliveredIds].slice(-MAX_DELIVERED_IDS)
      deliveredIds.clear()
      for (const id of retained) deliveredIds.add(id)
    }
    writeDeliveredIds(deliveredIds)
  }, [])

  // Track real OS focus via the Rust-emitted event rather than
  // document.visibilityState, which doesn't reliably reflect a window hidden
  // to the tray (see main.rs).
  useEffect(() => {
    if (!isNativeDesktopRuntime()) return

    let disposed = false
    let cleanup: (() => void) | undefined
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen<boolean>('hivekeep-window-focus', (event) => {
        focusedRef.current = event.payload
      }))
      .then((unlisten) => {
        if (disposed) {
          unlisten()
          return
        }
        cleanup = unlisten
      })
      .catch(() => undefined)

    return () => {
      disposed = true
      cleanup?.()
    }
  }, [])

  useSSE({
    'notification:new': (data) => {
      const notification = (data as { notification?: NotificationSummary }).notification
      if (notification) void deliver(notification)
    },
  })

  // SSE never replays events missed while disconnected (laptop sleep, network
  // drop) — catch up on anything unread once the stream resyncs.
  useSSEResync(() => {
    if (!isNativeDesktopRuntime()) return
    void api.get<NotificationsResponse>(`/notifications?unreadOnly=true&limit=${CATCH_UP_LIMIT}`)
      .then((data) => {
        for (const notification of data.notifications) void deliver(notification)
      })
      .catch(() => undefined)
  })
}
