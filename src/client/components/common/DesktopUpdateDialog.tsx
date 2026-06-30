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
import { Progress } from '@/client/components/ui/progress'
import { ArrowUpCircle, Download, Loader2 } from 'lucide-react'
import { useDesktopUpdater } from '@/client/hooks/useDesktopUpdater'

/**
 * Native counterpart to UpdateAvailableDialog: updates the desktop binary
 * itself via Tauri's updater plugin, rather than the server the browser
 * happens to be pointed at. Mounted once for the whole desktop shell.
 */
export function DesktopUpdateDialog() {
  const { t } = useTranslation()
  const { state, startUpdate, dismiss } = useDesktopUpdater()

  const open = state.status === 'available' || state.status === 'downloading' || state.status === 'restarting' || (state.status === 'error' && state.version !== null)
  if (!open) return null

  const busy = state.status === 'downloading' || state.status === 'restarting'
  const failed = state.status === 'error'

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) dismiss() }}>
      <DialogContent variant="panel" size="lg" showCloseButton={!busy && !failed}>
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-primary/10 p-2">
              <ArrowUpCircle className="size-5 text-primary" />
            </div>
            <div>
              <DialogTitle>{t('desktopUpdate.title')}</DialogTitle>
              <DialogDescription>
                {t('desktopUpdate.description', { version: state.version })}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <DialogBody className="space-y-3">
          {state.body && (
            <div>
              <h4 className="mb-2 text-sm font-semibold">{t('desktopUpdate.releaseNotes')}</h4>
              <p className="whitespace-pre-line text-xs text-muted-foreground">{state.body}</p>
            </div>
          )}

          {busy && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {state.status === 'restarting' ? t('desktopUpdate.restarting') : t('desktopUpdate.downloading')}
              </p>
              <Progress value={state.progress ?? 0} variant="gradient" active />
            </div>
          )}

          {failed && state.error && (
            <p className="text-sm text-destructive">{state.error}</p>
          )}
        </DialogBody>

        <DialogFooter>
          {!busy && (
            <Button variant="ghost" onClick={dismiss}>
              {t('desktopUpdate.later')}
            </Button>
          )}
          <Button onClick={() => void startUpdate()} disabled={busy && !failed}>
            {busy ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Download className="size-4 mr-2" />}
            {t('desktopUpdate.updateButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
