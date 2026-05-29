import { useTranslation } from 'react-i18next'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/client/components/ui/select'
import type { ThinkingChoice } from '@/client/lib/thinking-choice'

interface ThinkingEffortSelectProps {
  value: ThinkingChoice
  onChange: (value: ThinkingChoice) => void
  disabled?: boolean
  /** Label shown for the `inherit` option. Lets callers say "project/Kin" vs "Kin". */
  inheritLabel: string
  className?: string
}

/**
 * Single-select reasoning-effort dial backed by `ThinkingChoice`.
 *
 * Mirrors the effort `<Select>` used in project settings, but packaged so the
 * task-start dialogs can drop it in. Defaults caller-side to `'inherit'` so an
 * unset override changes nothing. The `inherit` label is caller-supplied
 * because the fallback source differs (project→Kin for ticket tasks, Kin for
 * orphan tasks).
 */
export function ThinkingEffortSelect({
  value,
  onChange,
  disabled = false,
  inheritLabel,
  className,
}: ThinkingEffortSelectProps) {
  const { t } = useTranslation()
  return (
    <Select value={value} onValueChange={(v) => onChange(v as ThinkingChoice)} disabled={disabled}>
      <SelectTrigger className={className ?? 'h-9'}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="inherit">
          <span className="italic text-muted-foreground">{inheritLabel}</span>
        </SelectItem>
        <SelectItem value="off">{t('chat.thinkingPicker.effort.off')}</SelectItem>
        <SelectItem value="low">{t('chat.thinkingPicker.effort.low')}</SelectItem>
        <SelectItem value="medium">{t('chat.thinkingPicker.effort.medium')}</SelectItem>
        <SelectItem value="high">{t('chat.thinkingPicker.effort.high')}</SelectItem>
        <SelectItem value="max">{t('chat.thinkingPicker.effort.max')}</SelectItem>
      </SelectContent>
    </Select>
  )
}
