import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { NotificationPanel } from '@/client/components/notifications/NotificationPanel'
import { MobilePage } from '@/client/components/layout/MobileAppShell'
import { useNotifications } from '@/client/hooks/useNotifications'
import type { NotificationSummary } from '@/shared/types'

export function MobileNotificationsPage({
  onOpenSettings,
}: {
  onOpenSettings: (section?: string) => void
}) {
  const navigate = useNavigate()
  const {
    notifications,
    unreadCount,
    isLoading,
    markAsRead,
    markAllAsRead,
    deleteNotification,
  } = useNotifications()

  const handleClick = useCallback((notification: NotificationSummary) => {
    const toAgent = () => {
      if (notification.agentSlug) navigate(`/agent/${notification.agentSlug}`)
    }

    switch (notification.type) {
      case 'prompt:pending':
      case 'agent:error':
      case 'agent:alert':
      case 'mention':
        toAgent()
        break
      case 'cron:pending-approval':
        navigate('/tasks')
        break
      case 'channel:user-pending':
        onOpenSettings('channels')
        break
      case 'mcp:pending-approval':
        onOpenSettings('mcp')
        break
      case 'email:pending-send-approval':
        onOpenSettings('emailAccounts')
        break
      case 'miniapp:notify':
        navigate('/')
        break
      default: {
        const _exhaustive: never = notification.type
        void _exhaustive
      }
    }
  }, [navigate, onOpenSettings])

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
          className="h-full max-h-none"
        />
      )}
    </MobilePage>
  )
}
