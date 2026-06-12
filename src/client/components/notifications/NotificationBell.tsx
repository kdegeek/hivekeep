import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Bell } from 'lucide-react'
import { useNotificationSound } from '@/client/hooks/useNotificationSound'
import { Button } from '@/client/components/ui/button'
import { Badge } from '@/client/components/ui/badge'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/client/components/ui/popover'
import { NotificationPanel } from './NotificationPanel'
import { useNotifications } from '@/client/hooks/useNotifications'
import type { NotificationSummary } from '@/shared/types'

interface NotificationBellProps {
  onOpenSettings?: (section?: string) => void
}

export function NotificationBell({ onOpenSettings }: NotificationBellProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const {
    notifications,
    unreadCount,
    markAsRead,
    markAllAsRead,
    deleteNotification,
  } = useNotifications()

  // Play a chime on new notifications (respects user preference)
  useNotificationSound()

  const handleClick = useCallback((notification: NotificationSummary) => {
    setOpen(false)

    // Open the Agent's conversation (where the prompt / mention / alert lives).
    const toAgent = () => {
      if (notification.agentSlug) navigate(`/agent/${notification.agentSlug}`)
    }

    switch (notification.type) {
      // Everything that surfaces inside an Agent's conversation.
      case 'prompt:pending':
      case 'agent:error':
      case 'agent:alert':
      case 'mention':
        toAgent()
        break
      // Cron approval lives on the Scheduled Tasks page (moved off the Agent
      // chat in the page reshuffle — this is the regression the bell still had).
      case 'cron:pending-approval':
        navigate('/crons')
        break
      // Settings-section approvals / setup.
      case 'channel:user-pending':
        onOpenSettings?.('channels')
        break
      case 'mcp:pending-approval':
        onOpenSettings?.('mcp')
        break
      case 'email:pending-send-approval':
        onOpenSettings?.('emailAccounts')
        break
      // Mini-app notifications land on the Mini-Apps page (the app that sent
      // it is identified by relatedId).
      case 'miniapp:notify':
        navigate('/mini-apps')
        break
      default: {
        // Exhaustiveness guard: adding a NotificationType without a target here
        // is a compile error, so a new notification can never silently dead-end.
        const _exhaustive: never = notification.type
        void _exhaustive
      }
    }
  }, [onOpenSettings, navigate])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative size-8" aria-label={t('accessibility.notifications')}>
          <Bell className="size-4" />
          {unreadCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full p-0 text-[9px]"
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 overflow-hidden p-0" sideOffset={8}>
        <NotificationPanel
          notifications={notifications}
          unreadCount={unreadCount}
          onMarkAsRead={markAsRead}
          onMarkAllAsRead={markAllAsRead}
          onDelete={deleteNotification}
          onClick={handleClick}
        />
      </PopoverContent>
    </Popover>
  )
}
