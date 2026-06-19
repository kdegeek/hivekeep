import { useTranslation } from 'react-i18next'
import { CheckCircle2, Loader2, Smartphone } from 'lucide-react'

/**
 * Presentational QR-pairing panel shared by every place that shows a WhatsApp
 * (or other `pairing:'qr'`) QR: the channel create dialog, the re-pair dialog,
 * and the in-chat setup card. Pure render — the caller owns the live QR (from
 * the `channel:pairing` SSE) and the connected state.
 */
export function QrPairingView({ qrImage, connected }: { qrImage: string; connected?: boolean }) {
  const { t } = useTranslation()

  if (connected) {
    return (
      <div className="flex flex-col items-center gap-3 py-2 text-center">
        <CheckCircle2 className="size-12 text-primary" />
        <p className="text-sm font-medium">{t('settings.channels.qr.connected')}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-3 py-1 text-center">
      <p className="text-sm text-muted-foreground">{t('settings.channels.qr.instructions')}</p>
      <div className="rounded-xl border border-border bg-white p-3">
        {qrImage ? (
          <img src={qrImage} alt="WhatsApp QR code" className="size-56" width={224} height={224} />
        ) : (
          <div className="flex size-56 items-center justify-center">
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Smartphone className="size-3.5" />
        {t('settings.channels.qr.waiting')}
      </p>
    </div>
  )
}
