import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/client/components/ui/dialog'
import { Button } from '@/client/components/ui/button'
import { QrPairingView } from '@/client/components/channel/QrPairingView'
import { useSSE } from '@/client/hooks/useSSE'
import { api, getErrorMessage } from '@/client/lib/api'

/**
 * Re-pair an EXISTING `pairing:'qr'` channel (e.g. a WhatsApp Web session that
 * logged out). Activates the channel to start a fresh pairing, shows the live
 * QR via the `channel:pairing` SSE, and closes once connected. Mirrors the
 * create dialog's QR step but for a channel that already exists.
 */
export function ChannelRepairDialog({
  open,
  onOpenChange,
  channel,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  channel: { id: string; name: string } | null
}) {
  const { t } = useTranslation()
  const [qrImage, setQrImage] = useState('')
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState('')

  // Kick off pairing when the dialog opens.
  useEffect(() => {
    if (!open || !channel) return
    setQrImage('')
    setConnected(false)
    setError('')
    api.post(`/channels/${channel.id}/activate`).catch((err) => setError(getErrorMessage(err)))
  }, [open, channel])

  useSSE({
    'channel:pairing': (data) => {
      if (!channel || data.channelId !== channel.id) return
      const status = data.status as string
      if (status === 'qr') {
        setQrImage(String(data.qrImage ?? ''))
      } else if (status === 'connected') {
        setConnected(true)
        setTimeout(() => onOpenChange(false), 1400)
      } else if (status === 'logged-out' || status === 'error') {
        setError(String(data.message ?? '') || t('settings.channels.qr.failed'))
      }
    },
  })

  const handleClose = (next: boolean) => {
    // Closing before it connects: deactivate so we don't keep an unpaired socket.
    if (!next && channel && !connected) {
      void api.post(`/channels/${channel.id}/deactivate`).catch(() => {})
    }
    onOpenChange(next)
  }

  if (!channel) return null

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.channels.qr.repairTitle', { name: channel.name })}</DialogTitle>
          <DialogDescription>{t('settings.channels.qr.repairHint')}</DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="text-sm text-destructive py-2">{error}</p>
        ) : (
          <QrPairingView qrImage={qrImage} connected={connected} />
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleClose(false)}>
            {connected ? t('common.close') : t('common.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
