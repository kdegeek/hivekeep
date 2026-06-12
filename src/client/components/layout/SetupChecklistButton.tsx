import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ListChecks } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { Badge } from '@/client/components/ui/badge'
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/client/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/client/components/ui/tooltip'
import { SetupChecklist } from '@/client/components/common/SetupChecklist'
import { useSetupChecklist } from '@/client/hooks/useSetupChecklist'

interface SetupChecklistButtonProps {
  onOpenSettings: (section?: string) => void
}

/**
 * Persistent navbar entry to the setup checklist.
 *
 * Visibility rule:
 *   - Hidden when every item is done OR dismissed (no actionable
 *     work + nothing to surface). The user can always re-open the
 *     checklist from Settings → General to restore skipped items.
 *   - Otherwise visible, with a badge count of pending (non-done +
 *     non-dismissed) items so the urgency is glanceable.
 *
 * Click opens a Popover anchored to the button containing the
 * compact variant of <SetupChecklist>. The compact layout has the
 * same data + actions as the full inline empty-state, just sized
 * for the topbar.
 */
export function SetupChecklistButton({ onOpenSettings }: SetupChecklistButtonProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { pendingCount, isComplete, items } = useSetupChecklist()
  const [open, setOpen] = useState(false)

  // 'Create Agent' lives in ChatPage's modal state. Navbar can't open it
  // directly without lifting state up to App.tsx (out of scope for this
  // phase); instead we route the user to the chat empty state, where
  // the inline checklist surfaces the same item with a CTA that opens
  // the modal locally. One extra click, much less restructure.
  const handleCreateAgent = () => navigate('/')

  // Hide the button entirely when there's nothing to do AND nothing
  // dismissed worth surfacing. The user can always re-open the
  // checklist from Settings → General if they want to revisit
  // skipped items later.
  const hasAnyDismissed = items.some((i) => i.isDismissed)
  if (isComplete && !hasAnyDismissed) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="relative"
                aria-label={t('setup.button.aria')}
              >
                <ListChecks className="size-4" />
                {pendingCount > 0 && (
                  <Badge
                    variant="default"
                    size="xs"
                    className="absolute -right-1 -top-1 size-4 min-w-4 justify-center rounded-full px-1 text-[10px] leading-none"
                  >
                    {pendingCount}
                  </Badge>
                )}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {pendingCount > 0
              ? t('setup.button.tooltipPending', { count: pendingCount })
              : t('setup.button.tooltipAllDone')}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <PopoverContent align="end" className="w-[380px] p-0">
        <PopoverHeader className="px-3 pt-3">
          <PopoverTitle className="flex items-center gap-2 text-sm font-semibold">
            <ListChecks className="size-4" />
            {t('setup.button.title')}
          </PopoverTitle>
        </PopoverHeader>
        <SetupChecklist
          variant="compact"
          onOpenSettings={onOpenSettings}
          onCreateAgent={handleCreateAgent}
          onAction={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  )
}
