import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/client/components/ui/dialog'
import { Button } from '@/client/components/ui/button'
import { ChatPanel } from '@/client/components/chat/ChatPanel'

type ChatPanelProps = React.ComponentProps<typeof ChatPanel>

/**
 * Distraction-less onboarding modal — a Dialog wrapping the real ChatPanel
 * (compact variant) pointed at the configurator Kin's MAIN thread, so the
 * conversation is the same one the user finds later in their Kin list. Closing
 * it asks for confirmation and dismisses; the thread is never lost.
 */
interface OnboardingChatModalProps {
  open: boolean
  onDismiss: () => void
  kin: ChatPanelProps['kin']
  llmModels: ChatPanelProps['llmModels']
  queueState?: ChatPanelProps['queueState']
  onModelChange: ChatPanelProps['onModelChange']
  onOpenSettings?: ChatPanelProps['onOpenSettings']
}

export function OnboardingChatModal({
  open,
  onDismiss,
  kin,
  llmModels,
  queueState,
  onModelChange,
  onOpenSettings,
}: OnboardingChatModalProps) {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) setConfirming(true) }}>
      <DialogContent className="flex h-[85vh] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">{kin.name}</DialogTitle>

        <div className="flex min-h-0 flex-1 flex-col">
          <ChatPanel
            kin={kin}
            llmModels={llmModels}
            queueState={queueState}
            onModelChange={onModelChange}
            onEditKin={() => {}}
            onOpenSettings={onOpenSettings}
            compact
          />
        </div>

        {confirming && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm">
            <div className="surface-card w-full max-w-sm space-y-4 rounded-xl border p-6 text-center shadow-lg">
              <h3 className="text-base font-semibold">
                {t('onboarding.modal.stopTitle', 'Stop the guided setup?')}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t(
                  'onboarding.modal.stopBody',
                  'You can pick up any time by chatting with Sherpa in your Kin list — your conversation is saved.',
                )}
              </p>
              <div className="flex justify-center gap-2">
                <Button variant="ghost" onClick={() => setConfirming(false)}>
                  {t('onboarding.modal.keepGoing', 'Keep going')}
                </Button>
                <Button variant="outline" onClick={onDismiss}>
                  {t('onboarding.modal.stop', 'Stop for now')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
