import { useState, useMemo, useCallback, useRef } from 'react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarSeparator,
  SidebarGroup,
} from '@/client/components/ui/sidebar'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/client/components/ui/tabs'
import { KinList } from '@/client/components/sidebar/KinList'
import { TaskList } from '@/client/components/sidebar/TaskList'
import { CronList } from '@/client/components/sidebar/CronList'
import { MiniAppList } from '@/client/components/sidebar/MiniAppList'
import { SidebarFooterContent } from '@/client/components/sidebar/SidebarFooterContent'
import { SystemHealthBar } from '@/client/components/sidebar/SystemHealthBar'
import { useTasks } from '@/client/hooks/useTasks'
import { cn } from '@/client/lib/utils'
import { useTranslation } from 'react-i18next'
import { ListTodo, CalendarClock, Blocks } from 'lucide-react'

const TAB_STORAGE_KEY = 'sidebar.activeTab'
const SPLIT_STORAGE_KEY = 'sidebar.splitPercent'
const SPLIT_DEFAULT = 50
const SPLIT_MIN = 20
const SPLIT_MAX = 80

interface KinSummary {
  id: string
  slug: string
  name: string
  role: string
  avatarUrl: string | null
  model: string
  providerId: string | null
  createdAt: string
}

interface AppSidebarProps {
  kins: KinSummary[]
  llmModels: { id: string; name: string; providerId: string; providerName: string; providerType: string; capability: string }[]
  selectedKinSlug: string | null
  selectedKinId: string | null
  unavailableKinIds: Set<string>
  kinQueueState: Map<string, { isProcessing: boolean; queueSize: number }>
  unreadCounts: Map<string, number>
  onSelectKin: (slug: string) => void
  onCreateKin: () => void
  onEditKin: (id: string) => void
  onDeleteKin?: (id: string) => void
  onReorderKins: (newOrder: string[]) => void
  onOpenSettings?: (section?: string, filters?: { kinId?: string }) => void
}

export function AppSidebar({
  kins,
  llmModels,
  selectedKinSlug,
  unavailableKinIds,
  kinQueueState,
  unreadCounts,
  onSelectKin,
  onCreateKin,
  onEditKin,
  onDeleteKin,
  onReorderKins,
  onOpenSettings,
}: AppSidebarProps) {
  const { t } = useTranslation()
  const taskData = useTasks()
  const activeCount = taskData.activeTasks.length
  const hasAwaiting = taskData.activeTasks.some((t) => t.status === 'awaiting_human_input' || t.status === 'awaiting_kin_response')

  const [activeTab, setActiveTab] = useState(() => {
    try {
      return localStorage.getItem(TAB_STORAGE_KEY) ?? 'tasks'
    } catch {
      return 'tasks'
    }
  })

  const [splitPercent, setSplitPercent] = useState(() => {
    try {
      const stored = localStorage.getItem(SPLIT_STORAGE_KEY)
      return stored ? Number(stored) : SPLIT_DEFAULT
    } catch {
      return SPLIT_DEFAULT
    }
  })

  const contentRef = useRef<HTMLDivElement>(null)
  const splitRef = useRef(splitPercent)
  splitRef.current = splitPercent

  const handleSplitMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const container = contentRef.current
    if (!container) return
    const containerRect = container.getBoundingClientRect()
    const startPercent = splitRef.current

    const handleMouseMove = (ev: MouseEvent) => {
      const deltaY = ev.clientY - startY
      const deltaPercent = (deltaY / containerRect.height) * 100
      const newPercent = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, startPercent + deltaPercent))
      setSplitPercent(newPercent)
      splitRef.current = newPercent
    }

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      try {
        localStorage.setItem(SPLIT_STORAGE_KEY, String(splitRef.current))
      } catch { /* ignore */ }
    }

    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [])

  const handleTabChange = useCallback((value: string) => {
    setActiveTab(value)
    try {
      localStorage.setItem(TAB_STORAGE_KEY, value)
    } catch { /* ignore */ }
  }, [])

  const cronKins = useMemo(
    () => kins.map((k) => ({ id: k.id, name: k.name, role: k.role, avatarUrl: k.avatarUrl })),
    [kins],
  )

  return (
    <Sidebar className="surface-sidebar">
      {/* Brand/logo lives in <AppTopBar /> now. SystemHealthBar takes the top slot. */}
      <SystemHealthBar onOpenSettings={onOpenSettings} />

      <SidebarSeparator />

      {/* Main content — disable native SidebarContent scroll, we manage it per-section */}
      <SidebarContent ref={contentRef} className="!overflow-hidden flex flex-col">
        {/* KinList — height controlled by split handle */}
        <div className="flex flex-col min-h-0 overflow-hidden" style={{ flexBasis: `${splitPercent}%`, flexShrink: 0, flexGrow: 0 }}>
          <KinList
            kins={kins}
            llmModels={llmModels}
            selectedKinSlug={selectedKinSlug}
            unavailableKinIds={unavailableKinIds}
            kinQueueState={kinQueueState}
            unreadCounts={unreadCounts}
            onSelectKin={onSelectKin}
            onCreateKin={onCreateKin}
            onEditKin={onEditKin}
            onDeleteKin={onDeleteKin}
            onViewUsage={onOpenSettings ? (kinId: string) => onOpenSettings('tokenUsage', { kinId }) : undefined}
            onReorderKins={onReorderKins}
          />
        </div>

        {/* Draggable horizontal resize handle */}
        <div
          onMouseDown={handleSplitMouseDown}
          className="relative shrink-0 cursor-row-resize group py-0.5"
        >
          <div className="mx-2 h-px bg-sidebar-border transition-colors group-hover:bg-primary/30 group-active:bg-primary/50" />
        </div>

        {/* Tabbed section: Tasks / Jobs / Apps — takes remaining space */}
        <SidebarGroup className="flex-1 flex flex-col min-h-0">
          <Tabs value={activeTab} onValueChange={handleTabChange} className="flex-1 flex flex-col min-h-0">
            <TabsList className="w-full shrink-0 mx-1 h-8">
              <TabsTrigger value="tasks" className="gap-1.5 text-xs">
                <ListTodo className="size-3.5" />
                {t('sidebar.tabs.tasks')}
                {activeCount > 0 && (
                  <span className={cn(
                    'ml-0.5 inline-flex items-center justify-center min-w-4 h-4 rounded-full bg-primary px-1 text-[9px] font-semibold text-primary-foreground leading-none',
                    hasAwaiting && 'animate-pulse bg-warning text-warning-foreground',
                  )}>
                    {activeCount}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="jobs" className="gap-1.5 text-xs">
                <CalendarClock className="size-3.5" />
                {t('sidebar.tabs.jobs')}
                {taskData.activeCronIds.size > 0 && (
                  <span className="ml-0.5 inline-block size-2 rounded-full bg-primary animate-pulse" />
                )}
              </TabsTrigger>
              <TabsTrigger value="apps" className="gap-1.5 text-xs">
                <Blocks className="size-3.5" />
                {t('sidebar.tabs.apps')}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="tasks" className="flex-1 min-h-0 flex flex-col">
              <TaskList llmModels={llmModels} taskData={taskData} />
            </TabsContent>

            <TabsContent value="jobs" className="flex-1 min-h-0 flex flex-col">
              <CronList kins={cronKins} llmModels={llmModels} activeCronIds={taskData.activeCronIds} />
            </TabsContent>

            <TabsContent value="apps" className="flex-1 min-h-0 flex flex-col">
              <MiniAppList />
            </TabsContent>
          </Tabs>
        </SidebarGroup>
      </SidebarContent>

      {/* Footer */}
      <SidebarFooter>
        <SidebarFooterContent onOpenSettings={onOpenSettings} />
      </SidebarFooter>
    </Sidebar>
  )
}
