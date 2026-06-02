import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarSeparator,
} from '@/client/components/ui/sidebar'
import { KinList } from '@/client/components/sidebar/KinList'
import { SidebarFooterContent } from '@/client/components/sidebar/SidebarFooterContent'
import { SystemHealthBar } from '@/client/components/sidebar/SystemHealthBar'

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

/**
 * Kins page sidebar.
 *
 * Now dedicated to the Kins list. Tasks, Scheduled Tasks and Mini-Apps used to
 * live in a tabbed bottom section here; they each have their own full-width
 * page (reached via the ActivityBar) so the sidebar can give the Kins list its
 * full height.
 */
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
  return (
    <Sidebar className="surface-sidebar">
      {/* Brand/logo lives in <AppTopBar /> now. SystemHealthBar takes the top slot. */}
      <SystemHealthBar onOpenSettings={onOpenSettings} />

      <SidebarSeparator />

      <SidebarContent className="!overflow-hidden flex flex-col">
        <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
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
      </SidebarContent>

      <SidebarFooter>
        <SidebarFooterContent onOpenSettings={onOpenSettings} />
      </SidebarFooter>
    </Sidebar>
  )
}
