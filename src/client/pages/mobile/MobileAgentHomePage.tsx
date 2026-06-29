import { Suspense, lazy, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Bot,
  ChevronRight,
  FolderKanban,
  Loader2,
  MessageCircle,
  Plus,
  Settings2,
  Sparkles,
} from 'lucide-react'
import { MobilePage, MobilePageBody } from '@/client/components/layout/MobileAppShell'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/components/ui/avatar'
import { Badge } from '@/client/components/ui/badge'
import { Button } from '@/client/components/ui/button'
import { Skeleton } from '@/client/components/ui/skeleton'
import { useAgents } from '@/client/hooks/useAgents'
import { useProjects } from '@/client/hooks/useProjects'
import { useUnreadPerAgent } from '@/client/hooks/useUnreadPerAgent'
import { cn } from '@/client/lib/utils'

const AgentFormModal = lazy(() => import('@/client/components/agent/AgentFormModal').then((m) => ({ default: m.AgentFormModal })))

interface MobileAgentHomePageProps {
  onOpenSettings: (section?: string, filters?: { agentId?: string }) => void
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || 'AI'
}

export function MobileAgentHomePage({ onOpenSettings }: MobileAgentHomePageProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const {
    agents,
    llmModels,
    imageModels,
    isLoading,
    agentQueueState,
    createAgent,
    getAgent,
    updateAgent,
    deleteAgent,
    uploadAvatar,
    generateAvatarPreview,
    hasImageCapability,
    refetchModels,
    generateAgentConfig,
    generateAvatarPreviewFromConfig,
  } = useAgents()
  const { projects } = useProjects()
  const { unreadCounts, clearUnread } = useUnreadPerAgent(null)
  const [editingAgent, setEditingAgent] = useState<Awaited<ReturnType<typeof getAgent>> | null>(null)
  const [editOpen, setEditOpen] = useState(false)

  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.title])),
    [projects],
  )

  const unavailableAgentIds = useMemo(() => {
    if (llmModels.length === 0) return new Set<string>()
    return new Set(agents.filter((agent) => !llmModels.some((model) => model.id === agent.model)).map((agent) => agent.id))
  }, [agents, llmModels])

  const activeCount = agents.filter((agent) => agentQueueState.get(agent.id)?.isProcessing).length
  const queuedCount = agents.reduce((sum, agent) => sum + (agentQueueState.get(agent.id)?.queueSize ?? 0), 0)
  const unreadTotal = Array.from(unreadCounts.values()).reduce((sum, count) => sum + count, 0)

  const openChat = (slug: string, agentId: string) => {
    clearUnread(agentId)
    navigate(`/agent/${slug}`)
  }

  const openAgentSettings = async (agentId: string) => {
    refetchModels()
    try {
      setEditingAgent(await getAgent(agentId))
      setEditOpen(true)
    } catch {
      // Keep the home usable if the detail fetch fails.
    }
  }

  const openCreateAgent = () => {
    refetchModels()
    setEditingAgent(null)
    setEditOpen(true)
  }

  return (
    <MobilePage>
      <MobilePageBody className="space-y-4 px-3 pb-4 pt-3">
        <section className="gradient-mesh relative overflow-hidden rounded-3xl border p-4 shadow-lg">
          <div className="theme-orb theme-orb-1 -left-16 -top-16 size-40" />
          <div className="theme-orb theme-orb-2 -right-12 top-8 size-32" style={{ animationDelay: '-3s' }} />
          <div className="relative space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full glass px-3 py-1 text-xs font-medium text-primary">
              <Sparkles className="size-3.5" />
              {t('mobileAgents.heroEyebrow', 'Agent home')}
            </div>
            <div>
              <h2 className="text-2xl font-bold tracking-tight">
                {t('mobileAgents.title', 'Your Agents')}
              </h2>
              <p className="mt-1 max-w-xs text-sm text-muted-foreground">
                {t('mobileAgents.subtitle', 'Jump into the right thread, see who is working, and keep every Agent in context.')}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="glass-strong rounded-2xl p-2.5">
                <p className="text-lg font-bold">{agents.length}</p>
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t('mobileAgents.stats.agents', 'Agents')}
                </p>
              </div>
              <div className="glass-strong rounded-2xl p-2.5">
                <p className="text-lg font-bold">{activeCount}</p>
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t('mobileAgents.stats.active', 'Active')}
                </p>
              </div>
              <div className="glass-strong rounded-2xl p-2.5">
                <p className="text-lg font-bold">{unreadTotal}</p>
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t('mobileAgents.stats.unread', 'Unread')}
                </p>
              </div>
            </div>
          </div>
        </section>

        {isLoading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((item) => (
              <div key={item} className="surface-card rounded-3xl border p-4">
                <div className="flex gap-3">
                  <Skeleton className="size-14 rounded-2xl" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-48" />
                    <Skeleton className="h-8 w-full rounded-xl" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : agents.length === 0 ? (
          <div className="surface-card flex flex-col items-center rounded-3xl border border-dashed p-8 text-center">
            <div className="gradient-primary flex size-14 items-center justify-center rounded-2xl text-white shadow-lg glow-primary">
              <Bot className="size-7" />
            </div>
            <h3 className="mt-4 font-semibold">{t('sidebar.agents.empty')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t('sidebar.agents.emptyDescription')}</p>
            <Button type="button" className="mt-5 rounded-2xl" onClick={openCreateAgent}>
              <Plus className="size-4" />
              {t('mobileAgents.createFirst', 'Create first Agent')}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between px-1">
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                {t('mobileAgents.cardsHeading', 'Agents')}
              </p>
              {queuedCount > 0 && (
                <Badge variant="secondary" className="rounded-full">
                  {t('mobileAgents.queuedSummary', '{{count}} queued', { count: queuedCount })}
                </Badge>
              )}
            </div>

            {agents.map((agent, index) => {
              const queueState = agentQueueState.get(agent.id)
              const isProcessing = queueState?.isProcessing ?? false
              const queueSize = queueState?.queueSize ?? 0
              const unread = unreadCounts.get(agent.id) ?? 0
              const projectName = agent.activeProjectId ? projectNames.get(agent.activeProjectId) : null
              const modelName = llmModels.find((model) => model.id === agent.model)?.name
              const modelUnavailable = unavailableAgentIds.has(agent.id)

              return (
                <article
                  key={agent.id}
                  className={cn(
                    'surface-card group relative overflow-hidden rounded-3xl border p-4 shadow-sm transition-transform active:scale-[0.99]',
                    isProcessing && 'gradient-border',
                  )}
                >
                  {unread > 0 && (
                    <span className="absolute right-4 top-4 z-10 inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-bold text-primary-foreground shadow-md">
                      {unread > 99 ? '99+' : unread}
                    </span>
                  )}

                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => openChat(agent.slug, agent.id)}
                      className="relative shrink-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={t('mobileAgents.openChatFor', 'Open chat with {{name}}', { name: agent.name })}
                    >
                      <Avatar className="size-16 rounded-2xl shadow-md">
                        {agent.avatarUrl && <AvatarImage src={agent.avatarUrl} alt={agent.name} />}
                        <AvatarFallback className="gradient-primary text-base font-bold text-white">
                          {initials(agent.name)}
                        </AvatarFallback>
                      </Avatar>
                      {isProcessing && (
                        <span className="absolute -bottom-1 -right-1 flex size-6 items-center justify-center rounded-full border-2 border-card bg-warning text-warning-foreground">
                          <Loader2 className="size-3.5 animate-spin" />
                        </span>
                      )}
                    </button>

                    <div className="min-w-0 flex-1 pr-7">
                      <button
                        type="button"
                        onClick={() => openChat(agent.slug, agent.id)}
                        className="block max-w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <h3 className="truncate text-lg font-semibold leading-tight">{agent.name}</h3>
                        <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{agent.role}</p>
                      </button>

                      <div className="mt-3 flex flex-wrap items-center gap-1.5">
                        <Badge
                          variant={isProcessing ? 'default' : queueSize > 0 ? 'secondary' : 'outline'}
                          className={cn('rounded-full', isProcessing && 'animate-pulse')}
                        >
                          {isProcessing ? (
                            <>
                              <Loader2 className="size-3 animate-spin" />
                              {t('agent.processing')}
                            </>
                          ) : queueSize > 0 ? (
                            t('mobileAgents.queueCount', '{{count}} queued', { count: queueSize })
                          ) : (
                            t('mobileAgents.idle', 'Idle')
                          )}
                        </Badge>
                        {projectName && (
                          <button
                            type="button"
                            onClick={() => navigate(`/projects/${agent.activeProjectId}`)}
                            className="inline-flex max-w-full items-center gap-1 rounded-full border bg-background/60 px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                          >
                            <FolderKanban className="size-3" />
                            <span className="truncate">{projectName}</span>
                          </button>
                        )}
                        {modelUnavailable && (
                          <Badge variant="outline" className="rounded-full text-warning">
                            <AlertTriangle className="size-3" />
                            {t('agent.modelUnavailable')}
                          </Badge>
                        )}
                      </div>

                      {modelName && (
                        <p className="mt-2 truncate text-[11px] text-muted-foreground/70">{modelName}</p>
                      )}
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-[1fr_auto] gap-2">
                    <Button
                      type="button"
                      onClick={() => openChat(agent.slug, agent.id)}
                      className="gradient-primary-hover rounded-2xl border-0 text-white shadow-md"
                    >
                      <MessageCircle className="size-4" />
                      {t('mobileAgents.openChat', 'Open chat')}
                      <ChevronRight className="ml-auto size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => openAgentSettings(agent.id)}
                      className="size-10 rounded-2xl glass"
                      aria-label={t('mobileAgents.openSettingsFor', 'Open settings for {{name}}', { name: agent.name })}
                      title={t('mobileAgents.openSettings', 'Settings')}
                    >
                      <Settings2 className="size-4" />
                    </Button>
                  </div>

                  <span className="pointer-events-none absolute bottom-3 right-4 text-[10px] font-semibold text-muted-foreground/30">
                    {index + 1}
                  </span>
                </article>
              )
            })}
          </div>
        )}
      </MobilePageBody>

      <Suspense fallback={null}>
        {editOpen && (
          <AgentFormModal
            open={editOpen}
            onOpenChange={setEditOpen}
            llmModels={llmModels}
            imageModels={imageModels}
            agent={editingAgent}
            onCreateAgent={createAgent}
            onUpdateAgent={updateAgent}
            onDeleteAgent={deleteAgent}
            onUploadAvatar={uploadAvatar}
            onGenerateAvatarPreview={generateAvatarPreview}
            onGenerateAgentConfig={generateAgentConfig}
            onGenerateAvatarPreviewFromConfig={generateAvatarPreviewFromConfig}
            hasImageCapability={hasImageCapability}
            onOpenSettings={onOpenSettings}
          />
        )}
      </Suspense>
    </MobilePage>
  )
}
