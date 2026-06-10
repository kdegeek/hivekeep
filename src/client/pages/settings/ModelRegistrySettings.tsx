import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Table2, ArrowUpRight } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { useSettingsClose } from '@/client/pages/settings/SettingsPage'

/**
 * Settings launcher for the model registry. The registry itself is a dense,
 * wide admin table that lives on its own full-width page (`/models`) — here in
 * the (narrow) Settings modal we only surface a pointer to it. Clicking opens
 * the page and closes the modal.
 */
export function ModelRegistrySettings() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const closeSettings = useSettingsClose()

  const open = () => {
    closeSettings()
    navigate('/models')
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{t('settings.modelRegistry.title', 'Models')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('settings.modelRegistry.subtitle',
            'Every model exposed by your providers. Metadata (context, capabilities, pricing) is auto-filled from the community models.dev database — edit any value to pin it, or remap a wrong match.')}
        </p>
      </div>

      <button
        type="button"
        onClick={open}
        className="surface-card group flex w-full items-center gap-4 rounded-lg border border-border p-4 text-left transition-colors hover:border-primary/40 hover:bg-muted/30"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Table2 className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t('settings.modelRegistry.openPageTitle', 'Open the model registry')}</span>
          <span className="block text-xs text-muted-foreground">
            {t('settings.modelRegistry.openPageHint', 'The full table opens on its own page — more room for context, pricing and capabilities.')}
          </span>
        </span>
        <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
      </button>

      <Button onClick={open} className="w-full sm:w-auto">
        <Table2 className="size-4" />
        {t('settings.modelRegistry.openPage', 'Open Models page')}
      </Button>
    </div>
  )
}
