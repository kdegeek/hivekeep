import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/components/ui/avatar'
import { timeAgo } from '@/client/lib/time'
import type { NotificationSummary } from '@/shared/types'

interface NotificationItemProps {
  notification: NotificationSummary
  onMarkAsRead: (id: string) => void
  onDelete: (id: string) => void
  onClick: (notification: NotificationSummary) => void
}

export function NotificationItem({ notification, onMarkAsRead, onDelete, onClick }: NotificationItemProps) {
  const { t } = useTranslation()

  const handleClick = () => {
    if (!notification.isRead) {
      onMarkAsRead(notification.id)
    }
    onClick(notification)
  }

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    onDelete(notification.id)
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`group flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors ${
        !notification.isRead
          ? 'border-l-[3px] border-primary bg-primary/10 hover:bg-primary/15'
          : 'border-l-[3px] border-transparent hover:bg-muted/50'
      }`}
    >
      <div className="relative mt-0.5 shrink-0">
        {notification.agentAvatarUrl ? (
          <Avatar className="size-7">
            <AvatarImage src={notification.agentAvatarUrl} alt={notification.agentName ?? ''} />
            <AvatarFallback className="text-[10px]">
              {notification.agentName?.slice(0, 2).toUpperCase() ?? 'K'}
            </AvatarFallback>
          </Avatar>
        ) : (
          <div className="flex size-7 items-center justify-center rounded-full bg-muted">
            <span className="text-[10px] font-medium text-muted-foreground">K</span>
          </div>
        )}
        {!notification.isRead && (
          <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary ring-2 ring-background" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className={`truncate text-sm ${!notification.isRead ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
            {notification.title}
          </p>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {timeAgo(notification.createdAt)}
          </span>
        </div>
        {notification.body && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {notification.body}
          </p>
        )}
        {notification.agentName && (
          <p className="mt-0.5 text-[10px] text-muted-foreground/70">
            {notification.agentName}
          </p>
        )}
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="mt-0.5 size-5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={handleDelete}
      >
        <X className="size-3" />
      </Button>
    </button>
  )
}
