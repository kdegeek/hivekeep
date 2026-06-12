import { useTranslation } from 'react-i18next'
import { Check, Copy, AlertTriangle } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { useCopyToClipboard } from '@/client/hooks/useCopyToClipboard'

interface ChannelWebhookFieldProps {
  /** Public inbound-webhook URL to paste into the external platform's console. */
  url: string
}

/**
 * Read-only display of a plugin channel's inbound-webhook URL with a copy
 * button. Shown in the expanded channel card for webhook-driven plugin
 * platforms (e.g. Twilio SMS) so the user knows exactly which URL to paste
 * into the provider's console — Hivekeep never registers it automatically.
 */
export function ChannelWebhookField({ url }: ChannelWebhookFieldProps) {
  const { t } = useTranslation()
  const { copy, copied } = useCopyToClipboard()
  const isLocalhost = /localhost|127\.0\.0\.1|0\.0\.0\.0|\bhttp:\/\//i.test(url)

  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
        {t('settings.channels.webhook.label')}
      </p>
      <div className="flex items-center gap-1.5">
        <code className="flex-1 min-w-0 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs text-foreground/90">
          {url}
        </code>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t('common.copy')}
          onClick={() => void copy(url)}
        >
          {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">{t('settings.channels.webhook.hint')}</p>
      {isLocalhost && (
        <p className="flex items-start gap-1 text-[11px] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span>{t('settings.channels.webhook.localhostWarning')}</span>
        </p>
      )}
    </div>
  )
}
