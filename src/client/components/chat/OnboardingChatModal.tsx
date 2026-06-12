import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Wrench, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/client/components/ui/dialog'
import { Button } from '@/client/components/ui/button'
import { ChatPanel } from '@/client/components/chat/ChatPanel'
import { useSSE } from '@/client/hooks/useSSE'
import { api } from '@/client/lib/api'

type ChatPanelProps = React.ComponentProps<typeof ChatPanel>

/**
 * Distraction-less onboarding modal: a Dialog wrapping the real ChatPanel
 * (compact variant) pointed at the configurator Agent's MAIN thread, so the
 * conversation is the same one the user finds later in their Agent list. Closing
 * it asks for confirmation and dismisses; the thread is never lost.
 *
 * Rescue affordance: when an `agent:error` SSE fires for the configurator
 * Agent during onboarding (most often a provider auth/config failure, which is
 * now diagnosable since list_providers surfaces invalid providers), we surface a
 * friendly banner with a "Reconfigure provider" button. The button posts a
 * plain user turn to Queenie asking her to help fix the provider, the safest,
 * least magical way to re-enter her provider-setup flow.
 */
interface OnboardingChatModalProps {
  open: boolean
  onDismiss: () => void
  agent: ChatPanelProps['agent']
  llmModels: ChatPanelProps['llmModels']
  queueState?: ChatPanelProps['queueState']
  onModelChange: ChatPanelProps['onModelChange']
  onOpenSettings?: ChatPanelProps['onOpenSettings']
}

export function OnboardingChatModal({
  open,
  onDismiss,
  agent,
  llmModels,
  queueState,
  onModelChange,
  onOpenSettings,
}: OnboardingChatModalProps) {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [reconfiguring, setReconfiguring] = useState(false)

  // Surface agent errors for the configurator Agent (Queenie) only. The toast
  // from useChat still fires globally; this banner is the actionable rescue.
  useSSE({
    'agent:error': (data) => {
      if (data.agentId !== agent.id) return
      setErrorMessage(
        (data.error as string | undefined) ?? t('errors.agentErrorGeneric'),
      )
    },
    // A successful answer means whatever broke is being worked through, so
    // clear the banner so it doesn't linger after the rescue turn.
    'chat:done': (data) => {
      if (data.agentId !== agent.id) return
      setErrorMessage(null)
    },
  })

  const handleReconfigure = useCallback(async () => {
    if (reconfiguring) return
    setReconfiguring(true)
    try {
      // Post a plain user turn so Queenie re-enters her provider-setup flow.
      // We don't echo it optimistically here. The chat:message SSE multi-device
      // broadcast adds it to the panel below within the same tick.
      await api.post(`/agents/${agent.id}/messages`, {
        content: t('onboarding.rescue.message'),
      })
      setErrorMessage(null)
    } catch {
      // Leave the banner up so the user can retry; the request failure is
      // surfaced by the global toast in the api client.
    } finally {
      setReconfiguring(false)
    }
  }, [agent.id, reconfiguring, t])

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) setConfirming(true) }}>
      <DialogContent className="flex h-[85vh] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">{agent.name}</DialogTitle>

        {errorMessage && (
          <div className="flex shrink-0 items-start gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1 space-y-2">
              <div>
                <p className="text-sm font-medium text-destructive">
                  {t('onboarding.rescue.title')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('onboarding.rescue.body', { error: errorMessage })}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={handleReconfigure}
                disabled={reconfiguring}
              >
                <Wrench className="size-3.5" />
                {reconfiguring
                  ? t('onboarding.rescue.reconfiguring')
                  : t('onboarding.rescue.reconfigure')}
              </Button>
            </div>
            <button
              type="button"
              onClick={() => setErrorMessage(null)}
              className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              aria-label={t('common.dismiss')}
            >
              <X className="size-4" />
            </button>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col">
          <ChatPanel
            agent={agent}
            llmModels={llmModels}
            queueState={queueState}
            onModelChange={onModelChange}
            onEditAgent={() => {}}
            onOpenSettings={onOpenSettings}
            compact
            hideThinking
          />
        </div>

        {confirming && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm">
            <div className="surface-card w-full max-w-sm space-y-4 rounded-xl border p-6 text-center shadow-lg">
              <h3 className="text-base font-semibold">
                {t('onboarding.modal.stopTitle')}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t('onboarding.modal.stopBody')}
              </p>
              <div className="flex justify-center gap-2">
                <Button variant="ghost" onClick={() => setConfirming(false)}>
                  {t('onboarding.modal.keepGoing')}
                </Button>
                <Button variant="outline" onClick={onDismiss}>
                  {t('onboarding.modal.stop')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
