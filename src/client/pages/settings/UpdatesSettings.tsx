import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/client/components/ui/button'
import { Badge } from '@/client/components/ui/badge'
import { Label } from '@/client/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/client/components/ui/select'
import { Skeleton } from '@/client/components/ui/skeleton'
import { HelpPanel } from '@/client/components/common/HelpPanel'
import { InfoTip } from '@/client/components/common/InfoTip'
import { UpdateChangelog } from '@/client/components/common/UpdateChangelog'
import { UpdateProgressView } from '@/client/components/common/UpdateProgressView'
import {
  DOCKER_UPDATE_COMMAND,
  UpdateResultBanner,
} from '@/client/components/common/UpdateResultBanner'
import { api, getErrorMessage } from '@/client/lib/api'
import { useAuth } from '@/client/hooks/useAuth'
import { useVersionCheck } from '@/client/hooks/useVersionCheck'
import {
  ArrowUpCircle,
  CheckCircle2,
  Copy,
  Download,
  FlaskConical,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { useCopyToClipboard } from '@/client/hooks/useCopyToClipboard'
import type { UpdateChannel, UpdateRunInfo, VersionInfo } from '@/shared/types'

const INSTALLATION_TYPE_LABELS: Record<VersionInfo['installationType'], string> = {
  docker: 'Docker',
  'systemd-system': 'systemd (system)',
  'systemd-user': 'systemd (user)',
  launchd: 'launchd (macOS)',
  manual: 'manual',
}

export function UpdatesSettings() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const { copy, copied } = useCopyToClipboard()
  const { versionInfo, isLoading, isChecking, refetch, forceCheck } = useVersionCheck()

  const [savingChannel, setSavingChannel] = useState(false)
  const [runId, setRunId] = useState<string | null>(null)
  const [result, setResult] = useState<UpdateRunInfo | null>(null)

  const handleChannelChange = async (channel: UpdateChannel) => {
    setSavingChannel(true)
    try {
      await api.put('/version-check/channel', { channel })
      await refetch()
      toast.success(t('settings.updates.channelSaved'))
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSavingChannel(false)
    }
  }

  const handleCheck = async () => {
    try {
      const info = await forceCheck()
      if (!info?.isUpdateAvailable) toast.success(t('sidebar.footer.upToDate'))
    } catch {
      toast.error(t('sidebar.footer.checkFailed'))
    }
  }

  const handleUpdate = async () => {
    try {
      const { runId: id } = await api.post<{ runId: string }>('/version-check/update')
      setResult(null)
      setRunId(id)
    } catch (err) {
      toast.error(t('updateAvailable.updateFailed'), { description: getErrorMessage(err) })
    }
  }

  const handleFinished = (run: UpdateRunInfo) => {
    setRunId(null)
    setResult(run)
    if (run.status === 'success') {
      toast.success(t('updateAvailable.updateSuccess', { version: run.toVersion }))
      setTimeout(() => window.location.reload(), 2500)
    }
  }

  if (isLoading || !versionInfo) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  const isDocker = versionInfo.installationType === 'docker'
  const updating = runId !== null

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">{t('settings.updates.title')}</h3>
        <p className="text-sm text-muted-foreground">{t('settings.updates.description')}</p>
      </div>

      <HelpPanel contentKey="settings.updates.help" />

      {/* Current version */}
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">
            Hivekeep v{versionInfo.currentVersion}
          </span>
          {versionInfo.currentSha && (
            <Badge variant="outline" className="font-mono text-[10px]">
              {versionInfo.currentSha}
            </Badge>
          )}
          <Badge variant="secondary" className="text-[10px]">
            {INSTALLATION_TYPE_LABELS[versionInfo.installationType]}
          </Badge>
          {versionInfo.isUpdateAvailable ? (
            <Badge variant="default" className="text-[10px]">
              <ArrowUpCircle className="size-3 mr-1" />
              {t('settings.updates.updateAvailableBadge', {
                version: versionInfo.latestVersion,
              })}
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px] text-emerald-500 border-emerald-500/30">
              <CheckCircle2 className="size-3 mr-1" />
              {t('settings.updates.upToDateBadge')}
            </Badge>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {versionInfo.lastCheckedAt && (
            <span>
              {t('settings.updates.lastChecked', {
                date: new Date(versionInfo.lastCheckedAt).toLocaleString(),
              })}
            </span>
          )}
          <Button
            variant="outline"
            size="xs"
            onClick={handleCheck}
            disabled={isChecking || !isAdmin}
          >
            {isChecking ? (
              <Loader2 className="size-3 mr-1 animate-spin" />
            ) : (
              <RefreshCw className="size-3 mr-1" />
            )}
            {t('sidebar.footer.checkForUpdates')}
          </Button>
        </div>
      </div>

      {/* Update channel */}
      <div className="space-y-2">
        <Label className="flex items-center gap-1.5">
          {t('settings.updates.channelLabel')}
          <InfoTip content={t('settings.updates.channelTip')} />
        </Label>
        <Select
          value={versionInfo.channel}
          onValueChange={(v) => handleChannelChange(v as UpdateChannel)}
          disabled={!isAdmin || savingChannel || updating}
        >
          <SelectTrigger className="w-full sm:w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stable">
              <span className="flex items-center gap-2">
                <CheckCircle2 className="size-4" />
                {t('updateChannel.stable')}
              </span>
            </SelectItem>
            <SelectItem value="edge">
              <span className="flex items-center gap-2">
                <FlaskConical className="size-4" />
                {t('updateChannel.edge')}
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {versionInfo.channel === 'stable'
            ? t('settings.updates.channelStableDescription')
            : t('settings.updates.channelEdgeDescription')}
        </p>
      </div>

      {/* Update available */}
      {versionInfo.isUpdateAvailable && !updating && !result && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
          <h4 className="text-sm font-semibold">
            {versionInfo.channel === 'edge'
              ? t('updateAvailable.newCommits', { count: versionInfo.changelog.length })
              : t('updateAvailable.description', {
                  current: versionInfo.currentVersion,
                  latest: versionInfo.latestVersion,
                })}
          </h4>

          {versionInfo.changelog.length > 0 && (
            <div className="max-h-72 overflow-y-auto">
              <UpdateChangelog changelog={versionInfo.changelog} channel={versionInfo.channel} />
            </div>
          )}

          {isDocker ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {t('updateAvailable.dockerInstructions')}
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 rounded-md bg-muted px-3 py-2 text-xs font-mono truncate">
                  {DOCKER_UPDATE_COMMAND}
                </code>
                <Button variant="outline" size="sm" className="shrink-0" onClick={() => copy(DOCKER_UPDATE_COMMAND)}>
                  <Copy className="size-3.5 mr-1" />
                  {copied ? t('common.copied') : t('common.copy')}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('updateAvailable.dockerTagNote', { version: versionInfo.latestVersion })}
              </p>
            </div>
          ) : versionInfo.canSelfUpdate ? (
            <div className="space-y-2">
              <Button onClick={handleUpdate} disabled={!isAdmin} className="w-full sm:w-auto">
                <Download className="size-4 mr-2" />
                {t('updateAvailable.updateButton')}
              </Button>
              <p className="text-xs text-muted-foreground">
                {t('updateAvailable.selfUpdateInstructions')}
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {versionInfo.selfUpdateBlockedReason === 'dev-mode'
                ? t('updateAvailable.devModeNote')
                : t('updateAvailable.manualInstallNote')}
            </p>
          )}
        </div>
      )}

      {/* Update in progress */}
      {updating && runId && (
        <div className="rounded-lg border p-4 space-y-3">
          <h4 className="text-sm font-semibold">{t('updateProgress.title')}</h4>
          <UpdateProgressView runId={runId} channel={versionInfo.channel} onFinished={handleFinished} />
          <p className="text-xs text-muted-foreground">{t('updateProgress.dontClose')}</p>
        </div>
      )}

      {/* Last run result */}
      {result && result.status !== 'success' && <UpdateResultBanner result={result} />}
    </div>
  )
}
