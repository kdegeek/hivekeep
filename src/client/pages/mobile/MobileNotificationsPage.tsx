import { useCallback, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Check, ExternalLink, Loader2, Settings, Trash2 } from 'lucide-react'
import { NotificationPanel } from '@/client/components/notifications/NotificationPanel'
import { NotificationPreferences } from '@/client/components/notifications/NotificationPreferences'
import { MobilePage } from '@/client/components/layout/MobileAppShell'
import { useNotifications } from '@/client/hooks/useNotifications'
import { Button } from '@/client/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/client/components/ui/sheet'
import { Badge } from '@/client/components/ui/badge'
import { timeAgo } from '@/client/lib/time'
import type { NotificationSummary } from '@/shared/types'

export function MobileNotificationsPage({
  onOpenSettings,
}: {
  onOpenSettings: (section?: string) => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedSnapshot, setSelectedSnapshot] = useState<NotificationSummary | null>(null)
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const {
    notifications,
    unreadCount,
    isLoading,
    markAsRead,
    markAllAsRead,
    deleteNotification,
  } = useNotifications()

  const selectedNotification = useMemo(
    () => notifications.find((n) => n.id === selectedId) ?? selectedSnapshot,
    [notifications, selectedId, selectedSnapshot],
  )

  const hasRelatedTarget = useCallback((notification: NotificationSummary) => {
    switch (notification.type) {
      case 'prompt:pending':
      case 'agent:error':
      case 'agent:alert':
      case 'mention':
        return Boolean(notification.agentSlug)
      case 'cron:pending-approval':
      case 'channel:user-pending':
      case 'mcp:pending-approval':
      case 'email:pending-send-approval':
      case 'miniapp:notify':
        return true
      default: {
        const _exhaustive: never = notification.type
        void _exhaustive
        return false
      }
    }
  }, [])

  const openDeepLink = useCallback((notification: NotificationSummary) => {
    const closeDetail = () => {
      setSelectedId(null)
      setSelectedSnapshot(null)
    }

    const toAgent = () => {
      if (!notification.agentSlug) return false
      navigate(`/agent/${notification.agentSlug}`)
      closeDetail()
      return true
    }

    switch (notification.type) {
      case 'prompt:pending':
      case 'agent:error':
      case 'agent:alert':
      case 'mention':
        if (!toAgent()) return
        break
      case 'cron:pending-approval':
        navigate('/tasks')
        closeDetail()
        break
      case 'channel:user-pending':
        onOpenSettings('channels')
        closeDetail()
        break
      case 'mcp:pending-approval':
        onOpenSettings('mcp')
        closeDetail()
        break
      case 'email:pending-send-approval':
        onOpenSettings('emailAccounts')
        closeDetail()
        break
      case 'miniapp:notify':
        navigate('/')
        closeDetail()
        break
      default: {
        const _exhaustive: never = notification.type
        void _exhaustive
      }
    }
  }, [navigate, onOpenSettings])

  const handleClick = useCallback((notification: NotificationSummary) => {
    setSelectedId(notification.id)
    setSelectedSnapshot(notification)
  }, [])

  const openPreferences = useCallback(() => {
    setSelectedId(null)
    setSelectedSnapshot(null)
    setPreferencesOpen(true)
  }, [])

  const handleMarkSelectedRead = useCallback(() => {
    if (!selectedNotification || selectedNotification.isRead) return
    markAsRead(selectedNotification.id)
  }, [markAsRead, selectedNotification])

  const handleDeleteSelected = useCallback(() => {
    if (!selectedNotification) return
    setSelectedId(null)
    setSelectedSnapshot(null)
    deleteNotification(selectedNotification.id)
  }, [deleteNotification, selectedNotification])

  return (
    <MobilePage>
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <NotificationPanel
          notifications={notifications}
          unreadCount={unreadCount}
          onMarkAsRead={markAsRead}
          onMarkAllAsRead={markAllAsRead}
          onDelete={deleteNotification}
          onClick={handleClick}
          onOpenPreferences={openPreferences}
          markReadOnClick={false}
          className="h-full max-h-none"
        />
      )}
      <Sheet
        open={selectedNotification !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedId(null)
            setSelectedSnapshot(null)
          }
        }}
      >
        <SheetContent side="bottom" className="max-h-[85dvh] rounded-t-3xl">
          {selectedNotification && (
            <>
              <SheetHeader className="border-b pr-12">
                <div className="flex items-center gap-2">
                  {!selectedNotification.isRead && <Badge size="xs">{t('notifications.unread', 'Unread')}</Badge>}
                  <Badge variant="outline" size="xs">
                    {t(`notifications.types.${selectedNotification.type.replace(/:/g, '-')}`)}
                  </Badge>
                </div>
                <SheetTitle className="text-left text-lg leading-tight">{selectedNotification.title}</SheetTitle>
                <SheetDescription className="text-left">
                  {selectedNotification.agentName
                    ? `${selectedNotification.agentName} • ${timeAgo(selectedNotification.createdAt)}`
                    : timeAgo(selectedNotification.createdAt)}
                </SheetDescription>
              </SheetHeader>

              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                {selectedNotification.body ? (
                  <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">{selectedNotification.body}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">{t('notifications.noDetail', 'No additional detail.')}</p>
                )}
                {selectedNotification.relatedType && (
                  <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-xl border bg-muted/30 p-3 text-xs">
                    <dt className="text-muted-foreground">{t('notifications.relatedType', 'Related')}</dt>
                    <dd>{selectedNotification.relatedType}</dd>
                    {selectedNotification.relatedId && (
                      <>
                        <dt className="text-muted-foreground">{t('notifications.relatedId', 'ID')}</dt>
                        <dd className="break-all font-mono">{selectedNotification.relatedId}</dd>
                      </>
                    )}
                  </dl>
                )}
              </div>

              <SheetFooter className="border-t">
                {hasRelatedTarget(selectedNotification) && (
                  <Button onClick={() => openDeepLink(selectedNotification)}>
                    <ExternalLink className="size-4" />
                    {t('notifications.openRelated', 'Open related item')}
                  </Button>
                )}
                {!selectedNotification.isRead && (
                  <Button variant="outline" onClick={handleMarkSelectedRead}>
                    <Check className="size-4" />
                    {t('notifications.markRead', 'Mark as read')}
                  </Button>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="outline" onClick={openPreferences}>
                    <Settings className="size-4" />
                    {t('notifications.preferences', 'Preferences')}
                  </Button>
                  <Button variant="destructive" onClick={handleDeleteSelected}>
                    <Trash2 className="size-4" />
                    {t('common.delete')}
                  </Button>
                </div>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>
      <Sheet open={preferencesOpen} onOpenChange={setPreferencesOpen}>
        <SheetContent side="bottom" className="max-h-[90dvh] rounded-t-3xl">
          <SheetHeader className="border-b pr-12">
            <SheetTitle className="text-left">{t('settings.notifications.title')}</SheetTitle>
            <SheetDescription className="text-left">{t('settings.notifications.description')}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <NotificationPreferences />
          </div>
        </SheetContent>
      </Sheet>
    </MobilePage>
  )
}
