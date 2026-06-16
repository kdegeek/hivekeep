import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bug, Lightbulb, MessageCircle } from 'lucide-react'
import { toast } from 'sonner'
import { FormDialog } from '@/client/components/common/FormDialog'
import { FormField } from '@/client/components/common/FormField'
import { Input } from '@/client/components/ui/input'
import { Textarea } from '@/client/components/ui/textarea'
import { cn } from '@/client/lib/utils'
import { api, getErrorMessage } from '@/client/lib/api'

type FeedbackType = 'bug' | 'suggestion' | 'experience'

const TYPES: Array<{ value: FeedbackType; icon: typeof Bug; labelKey: string }> = [
  { value: 'bug', icon: Bug, labelKey: 'feedback.type.bug' },
  { value: 'suggestion', icon: Lightbulb, labelKey: 'feedback.type.suggestion' },
  { value: 'experience', icon: MessageCircle, labelKey: 'feedback.type.experience' },
]

interface FeedbackDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmitted?: () => void
}

export function FeedbackDialog({ open, onOpenChange, onSubmitted }: FeedbackDialogProps) {
  const { t, i18n } = useTranslation()
  const [type, setType] = useState<FeedbackType>('suggestion')
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setType('suggestion')
    setMessage('')
    setEmail('')
    setError(null)
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) reset()
    onOpenChange(next)
  }

  const handleSubmit = async () => {
    if (!message.trim()) return
    setIsSubmitting(true)
    setError(null)
    try {
      await api.post('/feedback', {
        type,
        message: message.trim(),
        email: email.trim() || null,
        locale: i18n.language,
      })
      toast.success(t('feedback.dialog.success'))
      onSubmitted?.()
      handleOpenChange(false)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={t('feedback.dialog.title')}
      description={t('feedback.dialog.description')}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitDisabled={!message.trim()}
      submitLabel={t('feedback.dialog.submit')}
      error={error}
      size="md"
    >
      <FormField label={t('feedback.dialog.typeLabel')}>
        <div className="grid grid-cols-3 gap-2">
          {TYPES.map((option) => {
            const Icon = option.icon
            const active = type === option.value
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setType(option.value)}
                aria-pressed={active}
                className={cn(
                  'flex flex-col items-center gap-1.5 rounded-lg border p-3 text-xs font-medium transition-colors',
                  active
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon className="size-5" strokeWidth={1.75} />
                {t(option.labelKey)}
              </button>
            )
          })}
        </div>
      </FormField>

      <FormField label={t('feedback.dialog.messageLabel')} required>
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t(`feedback.dialog.messagePlaceholder.${type}`)}
          rows={5}
          autoFocus
          maxLength={5000}
        />
      </FormField>

      <FormField label={t('feedback.dialog.emailLabel')} hint={t('feedback.dialog.emailHint')}>
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t('feedback.dialog.emailPlaceholder')}
        />
      </FormField>
    </FormDialog>
  )
}
