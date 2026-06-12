import { useTranslation } from 'react-i18next'
import { CheckCircle2, ShieldAlert, Undo2 } from 'lucide-react'
import type { UpdateRunInfo } from '@/shared/types'

/** Canonical command shown to Docker installs (they update by repulling the image). */
export const DOCKER_UPDATE_COMMAND = 'docker compose pull && docker compose up -d'

interface UpdateResultBannerProps {
  result: UpdateRunInfo
}

/** Outcome banner of a self-update run — shared by the update dialog and the
 *  Settings → Updates section so the three terminal states always read the same. */
export function UpdateResultBanner({ result }: UpdateResultBannerProps) {
  const { t } = useTranslation()

  if (result.status === 'success') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3">
        <CheckCircle2 className="size-4 shrink-0 text-emerald-500 mt-0.5" />
        <div className="text-xs">
          <p className="font-medium">
            {t('updateAvailable.updateSuccess', { version: result.toVersion })}
          </p>
          <p className="mt-1 text-muted-foreground">{t('updateProgress.reloading')}</p>
        </div>
      </div>
    )
  }

  const rolledBack = result.status === 'rolled-back'
  return (
    <div
      className={
        rolledBack
          ? 'flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3'
          : 'flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3'
      }
    >
      {rolledBack ? (
        <Undo2 className="size-4 shrink-0 text-amber-500 mt-0.5" />
      ) : (
        <ShieldAlert className="size-4 shrink-0 text-destructive mt-0.5" />
      )}
      <div className="min-w-0 text-xs">
        <p className="font-medium">
          {rolledBack ? t('updateProgress.rolledBackTitle') : t('updateProgress.failedTitle')}
        </p>
        <p className="mt-1 text-muted-foreground">
          {rolledBack ? t('updateProgress.rolledBackDescription') : t('updateProgress.failedSafe')}
        </p>
        {result.error && (
          <p className="mt-1 break-words font-mono text-[11px] text-muted-foreground">
            {result.error}
          </p>
        )}
      </div>
    </div>
  )
}
