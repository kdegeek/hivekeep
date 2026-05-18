import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/client/components/ui/input'
import { PasswordInput } from '@/client/components/ui/password-input'
import { Button } from '@/client/components/ui/button'
import { Label } from '@/client/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/client/components/ui/select'
import { Alert, AlertDescription } from '@/client/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/client/components/ui/dialog'
import { CheckCircle2, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { FormErrorAlert } from '@/client/components/common/FormErrorAlert'
import { ProviderIcon } from '@/client/components/common/ProviderIcon'
import { InfoTip } from '@/client/components/common/InfoTip'
import { api, getErrorMessage } from '@/client/lib/api'
import { PROVIDER_API_KEY_URLS, PROVIDER_CAPABILITIES, PROVIDER_DISPLAY_NAMES, PROVIDER_TYPES, PROVIDERS_WITHOUT_API_KEY, PROVIDERS_WITH_OPTIONAL_API_KEY } from '@/shared/constants'
import type { ProviderType } from '@/shared/types'

/**
 * Per-provider placeholder for the credentials-file input shown when the
 * provider doesn't take an API key (auto-detected OAuth credentials). The
 * configSchema-driven form rendering — planned in a later phase — will
 * derive this from each LLMProvider's declared schema; for now we mirror
 * what the backend providers expect.
 */
const CREDENTIALS_PATH_PLACEHOLDERS: Record<string, string> = {
  'anthropic-oauth': '~/.claude/.credentials.json',
  'openai-codex': '~/.codex/auth.json',
}

interface EditProvider {
  id: string
  name: string
  type: string
}

interface ProviderFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
  /** Pass a provider to enter edit mode */
  provider?: EditProvider | null
  /** Filter which provider types to show (defaults to all) */
  providerTypes?: readonly string[]
}

export function ProviderFormDialog({ open, onOpenChange, onSaved, provider, providerTypes }: ProviderFormDialogProps) {
  const { t } = useTranslation()
  const isEditing = !!provider
  const [isSaving, setIsSaving] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [testPassed, setTestPassed] = useState(false)
  const [error, setError] = useState('')

  const types = providerTypes ?? PROVIDER_TYPES
  const defaultType = types[0] ?? PROVIDER_TYPES[0] ?? ''
  const [providerType, setProviderType] = useState<string>(defaultType)
  const [providerName, setProviderName] = useState('')
  const [apiKey, setApiKey] = useState('')
  /** When the selected type advertises multiple families (LLM / Embeddings /
   *  Images), the user picks which ones to actually create. Defaults to all
   *  three on first render; reset to all whenever the type changes. */
  const [selectedFamilies, setSelectedFamilies] = useState<readonly string[]>([])

  // Populate form when editing
  useEffect(() => {
    if (open && provider) {
      setProviderType(provider.type)
      setProviderName(provider.name)
      setApiKey('')
      setError('')
      setTestPassed(false)
    } else if (open && !provider) {
      resetForm()
    }
  }, [open, provider])

  const resetForm = () => {
    setProviderType(defaultType)
    setProviderName('')
    setApiKey('')
    setSelectedFamilies([])
    setError('')
    setTestPassed(false)
    setIsTesting(false)
    setIsSaving(false)
  }

  const handleClose = () => {
    resetForm()
    onOpenChange(false)
  }

  const resetTest = () => {
    setTestPassed(false)
    setError('')
  }

  const getCapabilitiesForType = (type: string): readonly string[] => {
    return PROVIDER_CAPABILITIES[type as ProviderType] ?? []
  }

  const isApiKeyOptional = (PROVIDERS_WITHOUT_API_KEY as readonly string[]).includes(providerType)
  const hasOptionalApiKey = (PROVIDERS_WITH_OPTIONAL_API_KEY as readonly string[]).includes(providerType)
  const apiKeyUrl = PROVIDER_API_KEY_URLS[providerType] as string | undefined

  // Families this provider type can serve, in display order. When more than
  // one is available, the form shows checkboxes so the user can opt into a
  // subset (e.g. only "Images" for OpenAI). Defaults all checked.
  const FAMILY_ORDER = ['llm', 'embedding', 'image'] as const
  const FAMILY_LABEL_KEY: Record<string, string> = {
    llm: 'onboarding.providers.familyLlm',
    embedding: 'onboarding.providers.familyEmbedding',
    image: 'onboarding.providers.familyImage',
  }
  const FAMILY_LABEL_FALLBACK: Record<string, string> = {
    llm: 'LLM (chat)',
    embedding: 'Embeddings (memory search)',
    image: 'Image generation',
  }
  const supportedFamilies = FAMILY_ORDER.filter((f) =>
    getCapabilitiesForType(providerType).includes(f),
  )
  // Initialise selected families when the type changes (or first selected).
  useEffect(() => {
    setSelectedFamilies(supportedFamilies)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerType])
  const showsFamilyPicker = !isEditing && supportedFamilies.length > 1
  const toggleFamily = (family: string) => {
    setSelectedFamilies((prev) =>
      prev.includes(family) ? prev.filter((f) => f !== family) : [...prev, family],
    )
    resetTest()
  }

  const handleTestConnection = async () => {
    setError('')
    setIsTesting(true)
    setTestPassed(false)

    try {
      const config: Record<string, string> = {}
      if (apiKey) config.apiKey = apiKey

      // For edit mode without new apiKey, test the existing provider
      if (isEditing && !apiKey) {
        const result = await api.post<{ valid: boolean; error?: string }>(`/providers/${provider!.id}/test`)
        if (result.valid) {
          setTestPassed(true)
        } else {
          setError(result.error || t('onboarding.providers.testFailed'))
        }
        return
      }

      const result = await api.post<{ valid: boolean; error?: string }>('/providers/test', {
        type: providerType,
        config,
      })

      if (result.valid) {
        setTestPassed(true)
      } else {
        setError(result.error || t('onboarding.providers.testFailed'))
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err) || t('onboarding.providers.testFailed'))
    } finally {
      setIsTesting(false)
    }
  }

  const handleSave = async () => {
    setError('')
    setIsSaving(true)

    try {
      if (isEditing) {
        const body: Record<string, unknown> = {}
        if (providerName !== provider!.name) body.name = providerName || provider!.type
        const config: Record<string, string> = {}
        if (apiKey) config.apiKey = apiKey
        if (Object.keys(config).length > 0) body.config = config
        if (providerName !== provider!.name || Object.keys(config).length > 0) {
          await api.patch(`/providers/${provider!.id}`, body)
        }
      } else {
        const config: Record<string, string> = {}
        if (apiKey) config.apiKey = apiKey
        await api.post('/providers', {
          name: providerName || (PROVIDER_DISPLAY_NAMES[providerType] ?? providerType),
          type: providerType,
          config,
          // Only send `families` when the picker was actually shown — otherwise
          // the backend defaults to "every family the type supports", which is
          // exactly what we want for single-family providers.
          ...(showsFamilyPicker ? { families: selectedFamilies } : {}),
        })
      }

      onSaved()
      handleClose()
    } catch (err: unknown) {
      setError(getErrorMessage(err) || t('onboarding.providers.testFailed'))
    } finally {
      setIsSaving(false)
    }
  }

  // In edit mode, the user can save name-only changes without re-testing
  const nameChanged = isEditing && providerName !== provider!.name
  const configChanged = !!apiKey
  const canSaveWithoutTest = isEditing && nameChanged && !configChanged
  // Block save when the family picker is shown and no family is selected —
  // the backend would reject this with NO_FAMILIES; surface the constraint
  // in the UI instead so the user doesn't have to round-trip.
  const familiesValid = !showsFamilyPicker || selectedFamilies.length > 0
  const canSave = (testPassed || canSaveWithoutTest) && familiesValid

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEditing ? t('settings.providers.edit') : t('onboarding.providers.addProvider')}
          </DialogTitle>
          <DialogDescription>
            {isEditing ? t('settings.providers.editHint') : t('onboarding.providers.addProviderHint')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <FormErrorAlert error={error} animate />

          {testPassed && (
            <Alert className="animate-scale-in border-primary/30 bg-primary/5 text-primary">
              <CheckCircle2 className="size-4" />
              <AlertDescription>{t('onboarding.providers.testSuccess')}</AlertDescription>
            </Alert>
          )}

          {!isEditing && types.length > 1 && (
            <div className="space-y-2">
              <Label>{t('onboarding.providers.type')}</Label>
              <Select value={providerType} onValueChange={(v) => {
                setProviderType(v)
                setProviderName('')
                resetTest()
              }}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {types.map((type) => (
                    <SelectItem key={type} value={type}>
                      <span className="flex items-center gap-2">
                        <ProviderIcon providerType={type} className="size-4 shrink-0" />
                        <span>{PROVIDER_DISPLAY_NAMES[type] ?? type}</span>
                        <span className="text-xs text-muted-foreground">
                          ({getCapabilitiesForType(type).join(', ')})
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="providerName" className="inline-flex items-center gap-1.5">
              {t('onboarding.providers.name')}
              <InfoTip content={t('onboarding.providers.nameTip')} />
              <span className="text-xs text-muted-foreground">
                ({t('common.optional')})
              </span>
            </Label>
            <Input
              id="providerName"
              value={providerName}
              onChange={(e) => setProviderName(e.target.value)}
              placeholder={t('onboarding.providers.namePlaceholder', { type: PROVIDER_DISPLAY_NAMES[providerType] ?? providerType })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="apiKey">
              {isApiKeyOptional ? t('onboarding.providers.credentialsPath') : t('onboarding.providers.apiKey')}
              {(isEditing || isApiKeyOptional) && (
                <span className="ml-1 text-xs text-muted-foreground">
                  ({isApiKeyOptional ? t('onboarding.providers.credentialsPathHint') : t('onboarding.providers.apiKeyEditHint')})
                </span>
              )}
            </Label>
            {isApiKeyOptional ? (
              <Input
                id="apiKey"
                type="text"
                value={apiKey}
                onChange={(e) => { setApiKey(e.target.value); resetTest() }}
                autoComplete="off"
                placeholder={CREDENTIALS_PATH_PLACEHOLDERS[providerType] ?? ''}
              />
            ) : (
              <PasswordInput
                id="apiKey"
                value={apiKey}
                onChange={(e) => { setApiKey(e.target.value); resetTest() }}
                autoComplete="off"
                placeholder={isEditing ? '••••••••' : undefined}
              />
            )}
            {apiKeyUrl && !isEditing && (
              <a
                href={apiKeyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                {t('onboarding.providers.getApiKey', { provider: PROVIDER_DISPLAY_NAMES[providerType] ?? providerType })}
                <ExternalLink className="size-3" />
              </a>
            )}
          </div>

          {showsFamilyPicker && (
            <div className="space-y-2">
              <Label className="text-sm">
                {t('onboarding.providers.familiesLabel', 'Enable for')}
              </Label>
              <div className="grid gap-1.5">
                {supportedFamilies.map((family) => (
                  <label
                    key={family}
                    className="flex cursor-pointer items-start gap-2 rounded-md border border-border/60 bg-card/50 p-2.5 hover:bg-card/80"
                  >
                    <input
                      type="checkbox"
                      checked={selectedFamilies.includes(family)}
                      onChange={() => toggleFamily(family)}
                      className="mt-0.5"
                    />
                    <span className="text-sm">
                      {t(FAMILY_LABEL_KEY[family]!, FAMILY_LABEL_FALLBACK[family]!)}
                    </span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {t(
                  'onboarding.providers.familiesHint',
                  'One row per family is created in the providers list, all sharing the same API key. You can rename, re-test or delete each one independently.',
                )}
              </p>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              {t('common.cancel')}
            </Button>
            {!canSave ? (
              <Button
                type="button"
                variant="secondary"
                onClick={handleTestConnection}
                disabled={isTesting || (!isEditing && !isApiKeyOptional && !hasOptionalApiKey && !apiKey)}
              >
                {isTesting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('onboarding.providers.testing')}
                  </>
                ) : (
                  <>
                    <RefreshCw className="size-4" />
                    {t('onboarding.providers.test')}
                  </>
                )}
              </Button>
            ) : (
              <Button
                type="button"
                onClick={handleSave}
                disabled={isSaving}
                className="btn-shine"
              >
                {isSaving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : isEditing ? (
                  t('common.save')
                ) : (
                  t('onboarding.providers.add')
                )}
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** @deprecated Use ProviderFormDialog instead */
export const AddProviderDialog = ProviderFormDialog
