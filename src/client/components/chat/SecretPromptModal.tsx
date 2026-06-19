import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, ExternalLink, Lock, Eye, TriangleAlert, LogIn } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/client/components/ui/dialog'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import { Label } from '@/client/components/ui/label'
import { useSecretPrompts } from '@/client/hooks/useSecretPrompts'
import { useSSE } from '@/client/hooks/useSSE'
import { QrPairingView } from '@/client/components/channel/QrPairingView'

/**
 * Secure-input modal: appears when the configurator Agent requests a secret
 * (API key, token) via request_provider_setup / prompt_secret. The value is
 * POSTed straight to the server (→ vault); it never goes through the LLM.
 *
 * Self-contained: pass the active Agent id; it subscribes to that Agent's pending
 * secret prompts and renders one at a time.
 */
export function SecretPromptModal({ agentId }: { agentId: string | null }) {
  const { t } = useTranslation()
  const { prompts, respond, cancel, isResponding } = useSecretPrompts(agentId)
  const [values, setValues] = useState<Record<string, string>>({})
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [qrImage, setQrImage] = useState('')

  const prompt = prompts.find((p) => p.promptId !== dismissed) ?? null

  // Reset the form whenever a different prompt comes to the front.
  useEffect(() => {
    setValues({})
    setQrImage((prompt?.kind === 'qr' && prompt.qr?.qrImage) || '')
  }, [prompt?.promptId]) // eslint-disable-line react-hooks/exhaustive-deps

  // For a QR card, follow the live pairing stream for this channel.
  useSSE({
    'channel:pairing': (data) => {
      if (!prompt || prompt.kind !== 'qr' || !prompt.qr) return
      if (data.channelId !== prompt.qr.channelId) return
      if (data.status === 'qr' && data.qrImage) setQrImage(String(data.qrImage))
    },
  })

  if (!prompt) return null

  // reveal: no inputs — an approval card (the agent asks to SEE a raw value).
  const isReveal = prompt.purpose === 'reveal'
  // oauth: interactive sign-in card (button → browser → paste the code back).
  const isOAuth = prompt.kind === 'oauth' && !!prompt.oauth
  // qr: pairing card — resolves from a server event, so it has no submit.
  const isQr = prompt.kind === 'qr' && !!prompt.qr
  const canSubmit = isOAuth
    ? (values.code?.trim().length ?? 0) > 0
    : prompt.fields.every((f) => !f.secret || (values[f.key]?.trim().length ?? 0) > 0)

  const handleSubmit = async () => {
    try {
      await respond(prompt.promptId, values)
      setValues({})
    } catch {
      // toast handled in the hook
    }
  }

  // Persistent dismiss: tell the server to cancel the prompt (resumes the Agent)
  // so it never re-appears. The X / click-away below only hides it for this
  // session.
  const handleCancel = async () => {
    try {
      await cancel(prompt.promptId)
      setValues({})
    } catch {
      // toast handled in the hook
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) setDismissed(prompt.promptId) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isReveal ? <Eye className="size-5 text-warning" /> : <ShieldCheck className="size-5 text-primary" />}
            {prompt.title}
          </DialogTitle>
          {prompt.description && <DialogDescription>{prompt.description}</DialogDescription>}
        </DialogHeader>

        <div className="space-y-4 py-2">
          {isQr && <QrPairingView qrImage={qrImage} />}

          {isOAuth && prompt.oauth && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {t('secretPrompt.oauthHint', { provider: prompt.oauth.providerDisplayName })}
              </p>
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                onClick={() => window.open(prompt.oauth!.authorizeUrl, '_blank', 'noopener,noreferrer')}
              >
                <LogIn className="size-4" />
                {t('secretPrompt.oauthSignIn', { provider: prompt.oauth.providerDisplayName })}
              </Button>
              {prompt.oauth.redirectStyle === 'loopback' && (
                <p className="rounded-md border border-border/60 bg-muted/40 p-2.5 text-xs text-muted-foreground">
                  {t('secretPrompt.oauthLoopbackHint')}
                </p>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="oauth-code">{t('secretPrompt.oauthCodeLabel')}</Label>
                <Input
                  id="oauth-code"
                  type="text"
                  autoComplete="off"
                  placeholder={
                    prompt.oauth.redirectStyle === 'loopback'
                      ? t('secretPrompt.oauthLoopbackPlaceholder')
                      : t('secretPrompt.oauthCodePlaceholder')
                  }
                  value={values.code ?? ''}
                  onChange={(e) => setValues((prev) => ({ ...prev, code: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) handleSubmit() }}
                  autoFocus
                />
              </div>
            </div>
          )}

          {!isOAuth && !isQr && prompt.fields.map((field) => (
            <div key={field.key} className="space-y-1.5">
              <Label htmlFor={`secret-${field.key}`}>{field.label}</Label>
              <Input
                id={`secret-${field.key}`}
                type={field.secret ? 'password' : 'text'}
                autoComplete="off"
                placeholder={field.placeholder}
                value={values[field.key] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) handleSubmit() }}
                autoFocus
              />
              {field.description && (
                <p className="text-xs text-muted-foreground">{field.description}</p>
              )}
              {field.keyUrl && (
                <a
                  href={field.keyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  {t('secretPrompt.getKey')}
                  <ExternalLink className="size-3" />
                </a>
              )}
            </div>
          ))}

          {isReveal ? (
            <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-foreground">
              <TriangleAlert className="size-4 shrink-0 text-warning" />
              <p>{t('secretPrompt.revealWarning')}</p>
            </div>
          ) : !isQr ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="size-3 shrink-0" />
              {t('secretPrompt.privacyNote')}
            </p>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={handleCancel} disabled={isResponding}>
            {isReveal ? t('secretPrompt.deny') : t('common.cancel')}
          </Button>
          {/* The QR card resolves from the pairing event — no submit button. */}
          {!isQr && (
            <Button onClick={handleSubmit} disabled={!canSubmit || isResponding}>
              {isResponding
                ? t('secretPrompt.saving')
                : isReveal
                  ? t('secretPrompt.approve')
                  : isOAuth
                    ? t('secretPrompt.connect')
                    : t('secretPrompt.submit')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
