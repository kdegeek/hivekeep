import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/client/components/ui/button'
import { Label } from '@/client/components/ui/label'
import { Switch } from '@/client/components/ui/switch'
import { MarkdownEditor } from '@/client/components/ui/markdown-editor'
import { api, getErrorMessage, toastError } from '@/client/lib/api'
import { Skeleton } from '@/client/components/ui/skeleton'
import { InfoTip } from '@/client/components/common/InfoTip'
import { HelpPanel } from '@/client/components/common/HelpPanel'
import { getToolCallsDefaultOpen, setToolCallsDefaultOpen } from '@/client/lib/tool-call-prefs'

export function GeneralSettings() {
  const { t } = useTranslation()

  const [isLoading, setIsLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  // Global prompt
  const [globalPrompt, setGlobalPrompt] = useState('')
  const [initialGlobalPrompt, setInitialGlobalPrompt] = useState('')

  // Saving state
  const [saving, setSaving] = useState(false)

  // Interface preference: expand tool calls by default (client-side, applies instantly)
  const [toolsDefaultOpen, setToolsDefaultOpenState] = useState(getToolCallsDefaultOpen)

  const handleToolsDefaultOpenChange = (value: boolean) => {
    setToolsDefaultOpenState(value)
    setToolCallsDefaultOpen(value)
  }

  useEffect(() => {
    setFetchError(null)
    fetchGlobalPrompt().catch(() => {})
  }, [])

  const fetchGlobalPrompt = async () => {
    try {
      const data = await api.get<{ globalPrompt: string }>('/settings/global-prompt')
      setGlobalPrompt(data.globalPrompt)
      setInitialGlobalPrompt(data.globalPrompt)
    } catch (err: unknown) {
      setFetchError(getErrorMessage(err))
      toast.error(t('settings.general.fetchError', 'Failed to load settings'))
    } finally {
      setIsLoading(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      if (hasPromptChanges) {
        await api.put('/settings/global-prompt', { globalPrompt })
        setInitialGlobalPrompt(globalPrompt)
      }
      toast.success(t('settings.general.saved'))
    } catch (err: unknown) {
      toastError(err)
    } finally {
      setSaving(false)
    }
  }

  const handleDiscard = () => {
    setGlobalPrompt(initialGlobalPrompt)
  }

  const MAX_PROMPT_LENGTH = 10000
  const hasPromptChanges = globalPrompt !== initialGlobalPrompt
  const hasChanges = hasPromptChanges
  const approxTokens = Math.ceil(globalPrompt.length / 4)
  const isOverLimit = globalPrompt.length > MAX_PROMPT_LENGTH

  if (isLoading) {
    return (
      <div className="space-y-8">
        <Skeleton className="h-4 w-3/4" />
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-[240px] w-full rounded-md" />
          <Skeleton className="h-3 w-48" />
        </div>
        <Skeleton className="h-9 w-20 rounded-md" />
      </div>
    )
  }

  if (fetchError) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive">{fetchError}</p>
        <Button variant="outline" onClick={() => {
          setIsLoading(true)
          setFetchError(null)
          fetchGlobalPrompt().catch(() => {})
        }}>
          {t('common.retry', 'Retry')}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <p className="text-sm text-muted-foreground">
        {t('settings.general.description')}
      </p>

      {/* Global prompt */}
      <div className="space-y-2">
        <Label htmlFor="global-prompt" className="inline-flex items-center gap-1.5">
          {t('settings.general.globalPrompt')}
          <InfoTip content={t('settings.general.globalPromptTip')} />
        </Label>
        <MarkdownEditor
          value={globalPrompt}
          onChange={setGlobalPrompt}
          height="240px"
        />
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {t('settings.general.globalPromptHint')}
          </p>
          <p className={`text-xs tabular-nums ${isOverLimit ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
            {globalPrompt.length.toLocaleString()}/{MAX_PROMPT_LENGTH.toLocaleString()} · ~{approxTokens} tokens
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          onClick={handleSave}
          disabled={!hasChanges || saving || isOverLimit}
        >
          {saving ? t('common.loading') : t('common.save')}
        </Button>
        {hasChanges && (
          <Button
            variant="ghost"
            onClick={handleDiscard}
          >
            {t('common.discard', 'Discard')}
          </Button>
        )}
      </div>

      {/* Interface preferences (applied instantly, stored locally) */}
      <div className="space-y-3 border-t border-border/60 pt-6">
        <h3 className="text-sm font-medium">{t('settings.general.interface.title')}</h3>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/30 px-4 py-3">
          <div className="space-y-0.5">
            <Label htmlFor="tools-default-open" className="cursor-pointer">
              {t('settings.general.toolsDefaultOpen.label')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t('settings.general.toolsDefaultOpen.hint')}
            </p>
          </div>
          <Switch
            id="tools-default-open"
            checked={toolsDefaultOpen}
            onCheckedChange={handleToolsDefaultOpenChange}
          />
        </div>
      </div>

      <HelpPanel
        contentKey="settings.general.help.content"
        bulletKeys={[
          'settings.general.help.bullet1',
        ]}
        storageKey="help.general.open"
      />
    </div>
  )
}
