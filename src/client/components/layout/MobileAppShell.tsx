import type { CSSProperties, ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Bell, Bot, ListTodo, MessageCircle, Settings } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import { useAuth } from '@/client/hooks/useAuth'
import { useTasksContext } from '@/client/contexts/TasksContext'
import { useNotifications } from '@/client/hooks/useNotifications'
import { useNotificationSound } from '@/client/hooks/useNotificationSound'
import { HivekeepLogo } from '@/client/components/common/HivekeepLogo'
import { ThemeToggle } from '@/client/components/common/ThemeToggle'
import { UserMenu } from '@/client/components/common/UserMenu'
import { SSEStatusIndicator } from '@/client/components/common/SSEStatusIndicator'
import { isCapacitorRuntime } from '@/client/lib/api'

type MobileTabKey = 'chat' | 'tasks' | 'notifications' | 'settings'

const safeTopStyle: CSSProperties = { paddingTop: 'env(safe-area-inset-top)' }
const safeBottomStyle: CSSProperties = { paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }
const nativeBottomNavStyle: CSSProperties = {
  left: 0,
  right: 0,
  bottom: 0,
  paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))',
}

export function MobilePage({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('surface-base flex h-full min-h-0 flex-col overflow-hidden', className)}>
      {children}
    </div>
  )
}

export function MobilePageBody({ children, className }: { children: ReactNode; className?: string }) {
  const nativeScrollClearanceStyle: CSSProperties | undefined = isCapacitorRuntime()
    ? { paddingBottom: 'calc(7rem + max(1.25rem, env(safe-area-inset-bottom)))' }
    : undefined
  const scrollSurfaceStyle: CSSProperties = {
    ...nativeScrollClearanceStyle,
    background: 'var(--color-background)',
    backfaceVisibility: 'hidden',
    transform: 'translateZ(0)',
    WebkitBackfaceVisibility: 'hidden',
  }

  return (
    <div
      className={cn('min-h-0 flex-1 overflow-y-auto px-4 py-3', className)}
      style={scrollSurfaceStyle}
    >
      {children}
    </div>
  )
}

function getActiveTab(pathname: string): MobileTabKey {
  if (pathname.startsWith('/tasks')) return 'tasks'
  if (pathname.startsWith('/notifications')) return 'notifications'
  if (pathname.startsWith('/settings') || pathname.startsWith('/models')) return 'settings'
  return 'chat'
}

export function MobileAppShell({
  children,
  onOpenSettings,
  onOpenAccount,
}: {
  children: ReactNode
  onOpenSettings: (section?: string, filters?: { agentId?: string }) => void
  onOpenAccount: () => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const { user, logout } = useAuth()
  const { activeTasks } = useTasksContext()
  const { unreadCount } = useNotifications()
  useNotificationSound()

  const activeTab = getActiveTab(location.pathname)
  const isChatDetail = location.pathname.startsWith('/agent/')
  const isNativeMobile = isCapacitorRuntime()
  const activeTaskCount = activeTasks.length
  const hasAwaitingTask = activeTasks.some(
    (task) => task.status === 'awaiting_human_input' || task.status === 'awaiting_agent_response',
  )

  const navItems: Array<{
    key: MobileTabKey
    to: string
    label: string
    icon: typeof MessageCircle
    badge?: { count: number; warning?: boolean }
  }> = [
    { key: 'chat', to: '/', label: t('activityBar.agents'), icon: Bot },
    {
      key: 'tasks',
      to: '/tasks',
      label: t('activityBar.tasks'),
      icon: ListTodo,
      badge: activeTaskCount > 0 ? { count: activeTaskCount, warning: hasAwaitingTask } : undefined,
    },
    {
      key: 'notifications',
      to: '/notifications',
      label: t('notifications.title'),
      icon: Bell,
      badge: unreadCount > 0 ? { count: unreadCount } : undefined,
    },
    { key: 'settings', to: '/settings', label: t('settings.title'), icon: Settings },
  ]

  const title = navItems.find((item) => item.key === activeTab)?.label ?? 'Hivekeep'

  const mainStyle: CSSProperties = {
    paddingBottom: isChatDetail
      ? undefined
      : isNativeMobile
        ? 'calc(4.25rem + max(1.25rem, env(safe-area-inset-bottom)))'
        : 'calc(4.25rem + max(0.5rem, env(safe-area-inset-bottom)))',
  }
  const navStyle: CSSProperties = {
    ...(isNativeMobile ? nativeBottomNavStyle : safeBottomStyle),
    background: 'var(--color-background)',
  }

  return (
    <div className="surface-base relative flex h-dvh w-screen flex-col overflow-hidden" style={safeTopStyle}>
      <header className="surface-header flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="flex shrink-0 items-center"
          aria-label="Hivekeep"
        >
          <HivekeepLogo size={24} title={null} />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h1>
        <div className="flex shrink-0 items-center gap-0.5">
          <SSEStatusIndicator />
          <ThemeToggle />
          {user && (
            <UserMenu
              user={{
                firstName: user.firstName,
                lastName: user.lastName,
                pseudonym: user.pseudonym,
                email: user.email,
                avatarUrl: user.avatarUrl,
              }}
              onLogout={logout}
              onOpenSettings={() => onOpenSettings()}
              onOpenAccount={onOpenAccount}
            />
          )}
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden" style={mainStyle}>{children}</main>

      {!isChatDetail && (
        <nav
          className={cn(
            'fixed z-50 px-2 pt-1.5',
            isNativeMobile
              ? 'border-t'
              : 'inset-x-0 bottom-0 border-t',
          )}
          style={navStyle}
          aria-label={t('appTopBar.sections', 'Sections')}
        >
          <div className="grid grid-cols-4 gap-1">
            {navItems.map((item) => {
              const Icon = item.icon
              const active = activeTab === item.key
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => navigate(item.to)}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'relative flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-2xl text-[11px] font-medium transition-colors',
                    active
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground active:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon className="size-5" strokeWidth={1.9} />
                  <span className="max-w-full truncate px-1">{item.label}</span>
                  {item.badge && (
                    <span
                      className={cn(
                        'absolute right-4 top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none',
                        item.badge.warning
                          ? 'animate-pulse bg-warning text-warning-foreground'
                          : 'bg-primary text-primary-foreground',
                      )}
                    >
                      {item.badge.count > 99 ? '99+' : item.badge.count}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </nav>
      )}
    </div>
  )
}
