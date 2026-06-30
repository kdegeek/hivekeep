import { useMemo, useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { LucideIcon } from 'lucide-react'
import {
  Bell,
  Bot,
  BrainCircuit,
  ChevronRight,
  Lock,
  MessageCircleQuestion,
  Palette,
  PlugZap,
  Radio,
  Server,
  Settings2,
  Sparkles,
  UserCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { SettingsPage } from '@/client/pages/settings/SettingsPage'
import type { SettingsFilters } from '@/client/pages/settings/SettingsPage'
import { MobilePage, MobilePageBody } from '@/client/components/layout/MobileAppShell'
import { Button } from '@/client/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/client/components/ui/card'
import { Input } from '@/client/components/ui/input'
import { ThemeToggle } from '@/client/components/common/ThemeToggle'
import {
  getErrorMessage,
  getHivekeepServerUrl,
  isMobileApiRuntime,
  setHivekeepServerUrl,
  validateHivekeepServerConnection,
} from '@/client/lib/api'

interface SettingsRouteState {
  section?: string
  filters?: SettingsFilters
}

interface MobileSettingsPageProps {
  onOpenAccount: () => void
}

interface HubAction {
  label: string
  onClick: () => void
  variant?: 'default' | 'outline' | 'secondary' | 'ghost'
}

interface HubCardProps {
  icon: LucideIcon
  title: string
  description: string
  actions: HubAction[]
}

function getInitialServerUrl(): string {
  try {
    return getHivekeepServerUrl() ?? ''
  } catch {
    return ''
  }
}

function getRouteSection(pathname: string): string | undefined {
  const match = pathname.match(/^\/settings\/([^/]+)/)
  return match?.[1]
}

function ServerConnectionCard() {
  const { t } = useTranslation()
  const [serverUrl, setServerUrl] = useState(getInitialServerUrl)
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  const saveServerUrl = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setIsSaving(true)

    try {
      const normalized = await validateHivekeepServerConnection(serverUrl)
      setHivekeepServerUrl(normalized)
      setServerUrl(normalized)
      toast.success(t('mobileConfig.serverSaved', 'Server connection saved'))
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Card className="gap-4 overflow-hidden border-primary/20 bg-primary/5 py-0 shadow-sm">
      <CardHeader className="px-4 pt-4">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Server className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <CardTitle className="text-base">{t('mobileConfig.server.title', 'Server connection')}</CardTitle>
            <CardDescription>
              {t('mobileConfig.server.description', 'Point this device at the Hivekeep server you want to use.')}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <form onSubmit={saveServerUrl} className="space-y-2">
          <div className="flex gap-2">
            <Input
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
              placeholder={t('mobile.connection.serverUrlPlaceholder', 'https://hivekeep.example.com')}
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              aria-label={t('mobileConfig.server.inputLabel', 'Hivekeep server URL')}
            />
            <Button type="submit" size="sm" disabled={isSaving}>
              {t('common.save', 'Save')}
            </Button>
          </div>
          {error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {isMobileApiRuntime()
                ? t('mobileConfig.server.mobileHint', 'Used for all mobile API and notification connections.')
                : t('mobileConfig.server.webHint', 'Mobile builds store this URL locally on the device.')}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  )
}

function ConfigHubCard({ icon: Icon, title, description, actions }: HubCardProps) {
  return (
    <Card className="gap-3 py-0 shadow-sm">
      <CardHeader className="px-4 pt-4">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <Icon className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2 px-4 pb-4">
        {actions.map((action) => (
          <Button
            key={action.label}
            type="button"
            size="sm"
            variant={action.variant ?? 'outline'}
            onClick={action.onClick}
            className="flex-1 justify-between sm:flex-none"
          >
            <span>{action.label}</span>
            <ChevronRight className="size-4" />
          </Button>
        ))}
      </CardContent>
    </Card>
  )
}

export function MobileSettingsPage({ onOpenAccount }: MobileSettingsPageProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const state = location.state as SettingsRouteState | null
  const routeSection = getRouteSection(location.pathname)
  const initialSection = state?.section ?? routeSection

  const cards = useMemo<HubCardProps[]>(() => [
    {
      icon: UserCircle,
      title: t('mobileConfig.account.title', 'Account & theme'),
      description: t('mobileConfig.account.description', 'Update your profile, language, password, and switch appearance quickly.'),
      actions: [
        { label: t('account.title', 'Account'), onClick: onOpenAccount, variant: 'default' },
      ],
    },
    {
      icon: Bot,
      title: t('mobileConfig.agents.title', 'Agents'),
      description: t('mobileConfig.agents.description', 'Return to chat to select, create, and work with your Agents.'),
      actions: [
        { label: t('mobileConfig.agents.open', 'Open Agents'), onClick: () => navigate('/') },
      ],
    },
    {
      icon: BrainCircuit,
      title: t('mobileConfig.providers.title', 'Providers & models'),
      description: t('mobileConfig.providers.description', 'Connect model providers, choose defaults, and review model metadata.'),
      actions: [
        { label: t('settings.providers.title', 'Providers'), onClick: () => navigate('/settings/providers'), variant: 'default' },
        { label: t('settings.models.title', 'Models'), onClick: () => navigate('/settings/models') },
      ],
    },
    {
      icon: Bell,
      title: t('mobileConfig.notifications.title', 'Notifications'),
      description: t('mobileConfig.notifications.description', 'Tune notification preferences for mobile alerts and status updates.'),
      actions: [
        { label: t('settings.notifications.title', 'Notifications'), onClick: () => navigate('/settings/notifications') },
      ],
    },
    {
      icon: Radio,
      title: t('mobileConfig.channels.title', 'Channels'),
      description: t('mobileConfig.channels.description', 'Manage chat, email, webhook, and connected communication surfaces.'),
      actions: [
        { label: t('settings.channels.title', 'Channels'), onClick: () => navigate('/settings/channels') },
        { label: t('settings.emailAccounts.title', 'Email'), onClick: () => navigate('/settings/emailAccounts') },
      ],
    },
    {
      icon: Lock,
      title: t('mobileConfig.vault.title', 'Vault'),
      description: t('mobileConfig.vault.description', 'Open secure entries for keys, credentials, and secrets used by Agents.'),
      actions: [
        { label: t('settings.vault.title', 'Vault'), onClick: () => navigate('/settings/vault') },
      ],
    },
    {
      icon: MessageCircleQuestion,
      title: t('mobileConfig.queenie.title', 'Queenie advanced setup'),
      description: t('mobileConfig.queenie.description', 'Ask Queenie for guided help when setup needs more context or custom choices.'),
      actions: [
        { label: t('mobileConfig.queenie.open', 'Ask Queenie'), onClick: () => navigate('/'), variant: 'secondary' },
      ],
    },
  ], [navigate, onOpenAccount, t])

  if (initialSection) {
    return (
      <SettingsPage
        initialSection={initialSection}
        initialFilters={state?.filters}
        showFooter={false}
      />
    )
  }

  return (
    <MobilePage>
      <MobilePageBody className="space-y-4 pb-6">
        <section className="rounded-3xl border bg-card p-4 shadow-sm">
          <div className="flex items-start gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
              <Settings2 className="size-5" />
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold tracking-tight">
                  {t('mobileConfig.title', 'Configuration hub')}
                </h2>
                <Sparkles className="size-4 text-primary" />
              </div>
              <p className="text-sm text-muted-foreground">
                {t('mobileConfig.description', 'Fast access to the setup surfaces that matter most on mobile.')}
              </p>
            </div>
          </div>
        </section>

        <ServerConnectionCard />

        <Card className="gap-3 py-0 shadow-sm">
          <CardHeader className="px-4 pt-4">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <Palette className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <CardTitle className="text-base">{t('mobileConfig.theme.title', 'Theme')}</CardTitle>
                <CardDescription>
                  {t('mobileConfig.theme.description', 'Switch light, dark, system, or contrast mode without leaving the hub.')}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-3 px-4 pb-4">
            <span className="text-sm text-muted-foreground">{t('accessibility.themeToggle', 'Toggle theme')}</span>
            <ThemeToggle />
          </CardContent>
        </Card>

        <div className="grid gap-3">
          {cards.map((card) => (
            <ConfigHubCard key={card.title} {...card} />
          ))}
        </div>

        <Card className="gap-3 border-dashed py-0 shadow-sm">
          <CardHeader className="px-4 pt-4">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <PlugZap className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <CardTitle className="text-base">{t('mobileConfig.more.title', 'More setup')}</CardTitle>
                <CardDescription>
                  {t('mobileConfig.more.description', 'Need plugins, MCP servers, toolboxes, users, logs, or updates? Open the full settings workspace.')}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <Button type="button" variant="outline" className="w-full justify-between" onClick={() => navigate('/settings/general')}>
              <span>{t('mobileConfig.more.open', 'Open full settings')}</span>
              <ChevronRight className="size-4" />
            </Button>
          </CardContent>
        </Card>
      </MobilePageBody>
    </MobilePage>
  )
}
