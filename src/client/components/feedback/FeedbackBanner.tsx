import { useTranslation } from 'react-i18next'
import { Star, MessageSquarePlus, X } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { useFeedback } from '@/client/contexts/FeedbackContext'

/**
 * Discreet, dismissible banner pinned at the top of the chat. Self-gates on the
 * feedback context: renders nothing unless the user is eligible for the
 * proactive prompt. The always-available entry points (ActivityBar, UserMenu)
 * are separate from this — dismissing the banner never hides those.
 */
export function FeedbackBanner() {
  const { t } = useTranslation()
  const { shouldPrompt, starred, open, star, snooze, dismiss } = useFeedback()

  if (!shouldPrompt) return null

  return (
    <div className="mx-auto w-full max-w-3xl px-2 pt-2 md:px-0">
      <div className="glass-subtle flex flex-col gap-2 rounded-lg border border-border px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">{t('feedback.banner.message')}</p>
        <div className="flex shrink-0 items-center gap-1.5">
          {!starred && (
            <Button variant="outline" size="sm" onClick={star}>
              <Star className="size-4" />
              <span className="hidden sm:inline">{t('feedback.banner.star')}</span>
            </Button>
          )}
          <Button variant="default" size="sm" className="btn-shine" onClick={open}>
            <MessageSquarePlus className="size-4" />
            {t('feedback.banner.give')}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={snooze}
            aria-label={t('feedback.banner.later')}
            title={t('feedback.banner.later')}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        className="mt-1 ml-1 text-[11px] text-muted-foreground/70 underline-offset-2 hover:text-muted-foreground hover:underline"
      >
        {t('feedback.banner.dontAskAgain')}
      </button>
    </div>
  )
}
