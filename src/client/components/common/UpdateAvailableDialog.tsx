import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '@/client/components/ui/dialog'
import { Button } from '@/client/components/ui/button'
import { Badge } from '@/client/components/ui/badge'
import { ArrowUpCircle, Copy, Download, ExternalLink } from 'lucide-react'
import { useCopyToClipboard } from '@/client/hooks/useCopyToClipboard'
import { useAuth } from '@/client/hooks/useAuth'
import { api, getErrorMessage } from '@/client/lib/api'
import { toast } from 'sonner'
import { UpdateChangelog } from '@/client/components/common/UpdateChangelog'
import { UpdateProgressView } from '@/client/components/common/UpdateProgressView'
import {
  DOCKER_UPDATE_COMMAND,
  UpdateResultBanner,
} from '@/client/components/common/UpdateResultBanner'
import type { UpdateRunInfo, VersionInfo } from '@/shared/types'

interface UpdateAvailableDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  versionInfo: VersionInfo
}

type DialogMode = 'info' | 'updating' | 'result'

export function UpdateAvailableDialog({
  open,
  onOpenChange,
  versionInfo,
}: UpdateAvailableDialogProps) {
  const { t } = useTranslation()
  const { copy, copied } = useCopyToClipboard()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [mode, setMode] = useState<DialogMode>('info')
  const [runId, setRunId] = useState<string | null>(null)
  const [result, setResult] = useState<UpdateRunInfo | null>(null)

  const isDocker = versionInfo.installationType === 'docker'
  const current =
    versionInfo.channel === 'edge'
      ? `${versionInfo.currentVersion} (${versionInfo.currentSha ?? '?'})`
      : versionInfo.currentVersion
  const latest = versionInfo.latestVersion ?? ''

  const handleUpdate = async () => {
    try {
      const { runId: id } = await api.post<{ runId: string }>('/version-check/update')
      setRunId(id)
      setMode('updating')
    } catch (err) {
      toast.error(t('updateAvailable.updateFailed'), { description: getErrorMessage(err) })
    }
  }

  const handleFinished = (run: UpdateRunInfo) => {
    setResult(run)
    setMode('result')
    if (run.status === 'success') {
      toast.success(t('updateAvailable.updateSuccess', { version: run.toVersion }))
      // The frontend assets changed under us — reload onto the new build.
      setTimeout(() => window.location.reload(), 2500)
    }
  }

  const handleOpenChange = (next: boolean) => {
    // The update keeps running server-side, but closing the only progress
    // window mid-flight is confusing — keep it open until a terminal state.
    if (!next && mode === 'updating') return
    if (!next) {
      setMode('info')
      setRunId(null)
      setResult(null)
    }
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent variant="panel" size="2xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-primary/10 p-2">
              <ArrowUpCircle className="size-5 text-primary" />
            </div>
            <div>
              <DialogTitle>{t('updateAvailable.title')}</DialogTitle>
              <DialogDescription>
                {t('updateAvailable.description', { current, latest })}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {/* Version + channel badges */}
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="text-xs">
              {t('updateAvailable.current')}: {versionInfo.channel === 'edge' ? current : `v${current}`}
            </Badge>
            <span className="text-muted-foreground">→</span>
            <Badge variant="default" className="text-xs">
              {t('updateAvailable.latest')}: {versionInfo.channel === 'edge' ? latest : `v${latest}`}
            </Badge>
            <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
              {t(`updateChannel.${versionInfo.channel}`)}
            </Badge>
          </div>

          {mode === 'info' && versionInfo.changelog.length > 0 && (
            <div className="flex flex-col">
              <h4 className="mb-2 text-sm font-semibold">
                {versionInfo.channel === 'edge'
                  ? t('updateAvailable.newCommits', { count: versionInfo.changelog.length })
                  : t('updateAvailable.releaseNotes')}
              </h4>
              <UpdateChangelog changelog={versionInfo.changelog} channel={versionInfo.channel} />
            </div>
          )}

          {mode === 'updating' && runId && (
            <div className="flex flex-col">
              <h4 className="mb-2 text-sm font-semibold">{t('updateProgress.title')}</h4>
              <UpdateProgressView
                runId={runId}
                channel={versionInfo.channel}
                onFinished={handleFinished}
              />
              <p className="mt-3 text-xs text-muted-foreground">
                {t('updateProgress.dontClose')}
              </p>
            </div>
          )}

          {mode === 'result' && result && <UpdateResultBanner result={result} />}
        </DialogBody>

        {mode === 'info' && (
          <DialogFooter className="flex-col items-stretch gap-3 sm:flex-col sm:items-stretch">
            <h4 className="text-sm font-semibold">{t('updateAvailable.howToUpdate')}</h4>

            {isDocker ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {t('updateAvailable.dockerInstructions')}
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 rounded-md bg-muted px-3 py-2 text-xs font-mono truncate">
                    {DOCKER_UPDATE_COMMAND}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => copy(DOCKER_UPDATE_COMMAND)}
                  >
                    <Copy className="size-3.5 mr-1" />
                    {copied ? t('common.copied') : t('common.copy')}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('updateAvailable.dockerTagNote', { version: latest })}
                </p>
              </div>
            ) : versionInfo.canSelfUpdate ? (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  {t('updateAvailable.selfUpdateInstructions')}
                </p>
                <Button onClick={handleUpdate} disabled={!isAdmin} className="w-full">
                  <Download className="size-4 mr-2" />
                  {t('updateAvailable.updateButton')}
                </Button>
                {!isAdmin && (
                  <p className="text-center text-xs text-muted-foreground">
                    {t('updateAvailable.adminOnly')}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {versionInfo.selfUpdateBlockedReason === 'dev-mode'
                  ? t('updateAvailable.devModeNote')
                  : t('updateAvailable.manualInstallNote')}
              </p>
            )}

            {versionInfo.releaseUrl && (
              <a
                href={versionInfo.releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
              >
                <ExternalLink className="size-3" />
                {t('updateAvailable.viewOnGitHub')}
              </a>
            )}
          </DialogFooter>
        )}

        {mode === 'result' && (
          <DialogFooter>
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              {t('common.close')}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
