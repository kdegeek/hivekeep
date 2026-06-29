import { useTranslation } from 'react-i18next'
import { BellOff, CheckCheck, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { NotificationItem } from './NotificationItem'
import { cn } from '@/client/lib/utils'
import type { NotificationSummary } from '@/shared/types'

interface NotificationPanelProps {
  notifications: NotificationSummary[]
  unreadCount: number
  onMarkAsRead: (id: string) => void
  onMarkAllAsRead: () => void
  onDelete: (id: string) => void
  onClick: (notification: NotificationSummary) => void
  onOpenPreferences?: () => void
  markReadOnClick?: boolean
  className?: string
}

export function NotificationPanel({
  notifications,
  unreadCount,
  onMarkAsRead,
  onMarkAllAsRead,
  onDelete,
  onClick,
  onOpenPreferences,
  markReadOnClick,
  className,
}: NotificationPanelProps) {
  const { t } = useTranslation()

  return (
    <div className={cn('flex max-h-[400px] flex-col', className)}>
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h3 className="text-sm font-semibold">{t('notifications.title')}</h3>
        <div className="flex items-center gap-1.5">
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs text-muted-foreground"
              onClick={onMarkAllAsRead}
            >
              <CheckCheck className="size-3.5" />
              {t('notifications.markAllRead')}
            </Button>
          )}
          {onOpenPreferences && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs text-muted-foreground"
              onClick={onOpenPreferences}
            >
              <SlidersHorizontal className="size-3.5" />
              {t('notifications.preferences', 'Preferences')}
            </Button>
          )}
        </div>
      </div>

      {/* List */}
      {notifications.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground">
          <BellOff className="size-8 opacity-40" />
          <p className="text-sm">{t('notifications.empty')}</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          <div className="flex flex-col gap-0.5 p-1.5">
            {notifications.map((n) => (
              <NotificationItem
                key={n.id}
                notification={n}
                onMarkAsRead={onMarkAsRead}
                onDelete={onDelete}
                onClick={onClick}
                markReadOnClick={markReadOnClick}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
