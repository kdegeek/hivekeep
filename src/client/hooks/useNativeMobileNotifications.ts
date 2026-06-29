import { useCallback, useEffect, useRef } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'
import { api, isMobileApiRuntime } from '@/client/lib/api'
import type { NotificationSummary, NotificationType } from '@/shared/types'

const POLL_INTERVAL_MS = 60_000
const POLL_LIMIT = 10
const MAX_DELIVERED_IDS = 200
const DELIVERED_STORAGE_KEY = 'hivekeep:nativeDeliveredNotificationIds'
const CHANNEL_ID = 'hivekeep-unread'

interface NotificationsResponse {
  notifications: NotificationSummary[]
  unreadCount: number
}

interface NativeNotificationExtra {
  notificationId?: string
  type?: NotificationType
  agentSlug?: string | null
}

function isNativeMobileRuntime(): boolean {
  return isMobileApiRuntime() && Capacitor.isNativePlatform()
}

function notificationIdToLocalId(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) {
    hash = (Math.imul(hash, 31) + id.charCodeAt(i)) | 0
  }
  return (hash >>> 0) % 2_147_483_647 || 1
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

function routeForNotification(extra: NativeNotificationExtra): string {
  if (extra.agentSlug && (
    extra.type === 'prompt:pending' ||
    extra.type === 'agent:error' ||
    extra.type === 'agent:alert' ||
    extra.type === 'mention'
  )) {
    return `/agent/${extra.agentSlug}`
  }

  if (extra.type === 'cron:pending-approval') return '/tasks'
  if (extra.type === 'channel:user-pending') return '/settings/channels'
  if (extra.type === 'mcp:pending-approval') return '/settings/mcp'
  if (extra.type === 'email:pending-send-approval') return '/settings/emailAccounts'
  if (extra.type === 'miniapp:notify') return '/'
  return '/notifications'
}

async function ensureNotificationPermission(): Promise<boolean> {
  const current = await LocalNotifications.checkPermissions()
  if (current.display === 'granted') return true
  if (current.display === 'denied') return false
  const requested = await LocalNotifications.requestPermissions()
  return requested.display === 'granted'
}

async function ensureAndroidChannel(): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') return
  await LocalNotifications.createChannel({
    id: CHANNEL_ID,
    name: 'Hivekeep unread notifications',
    description: 'Unread Hivekeep notifications from your configured server.',
    importance: 4,
    visibility: 1,
  })
}

export function useNativeMobileNotifications(navigate: (path: string) => void): void {
  const deliveredIdsRef = useRef<Set<string>>(readDeliveredIds())
  const isPollingRef = useRef(false)

  const pollUnreadNotifications = useCallback(async () => {
    if (!isNativeMobileRuntime() || isPollingRef.current) return
    isPollingRef.current = true

    try {
      const data = await api.get<NotificationsResponse>(`/notifications?unreadOnly=true&limit=${POLL_LIMIT}`)
      const deliveredIds = deliveredIdsRef.current
      const freshUnread = data.notifications
        .filter((notification) => !notification.isRead && !deliveredIds.has(notification.id))
        .reverse()

      if (freshUnread.length === 0) return
      const canNotify = await ensureNotificationPermission()
      if (!canNotify) return
      await ensureAndroidChannel()

      await LocalNotifications.schedule({
        notifications: freshUnread.map((notification) => ({
          id: notificationIdToLocalId(notification.id),
          title: notification.title,
          body: notification.body ?? notification.agentName ?? 'Unread Hivekeep notification',
          channelId: CHANNEL_ID,
          group: 'hivekeep-unread',
          autoCancel: true,
          extra: {
            notificationId: notification.id,
            type: notification.type,
            agentSlug: notification.agentSlug,
          } satisfies NativeNotificationExtra,
        })),
      })

      for (const notification of freshUnread) {
        deliveredIds.add(notification.id)
      }
      if (deliveredIds.size > MAX_DELIVERED_IDS) {
        const retainedIds = [...deliveredIds].slice(-MAX_DELIVERED_IDS)
        deliveredIds.clear()
        for (const id of retainedIds) {
          deliveredIds.add(id)
        }
      }
      writeDeliveredIds(deliveredIds)
    } catch {
      // Polling native notifications is best-effort and should never interrupt app use.
    } finally {
      isPollingRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!isNativeMobileRuntime()) return
    void pollUnreadNotifications()

    const intervalId = window.setInterval(() => {
      void pollUnreadNotifications()
    }, POLL_INTERVAL_MS)

    let isMounted = true
    const removeListeners: Array<() => Promise<void>> = []

    void CapacitorApp.addListener('resume', () => {
      void pollUnreadNotifications()
    }).then((handle) => {
      if (isMounted) removeListeners.push(handle.remove)
      else void handle.remove()
    })

    void LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
      const extra = action.notification.extra as NativeNotificationExtra | undefined
      navigate(routeForNotification(extra ?? {}))
    }).then((handle) => {
      if (isMounted) removeListeners.push(handle.remove)
      else void handle.remove()
    })

    return () => {
      isMounted = false
      window.clearInterval(intervalId)
      for (const remove of removeListeners) {
        void remove()
      }
    }
  }, [navigate, pollUnreadNotifications])
}
