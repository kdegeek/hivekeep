import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/client/components/ui/input'
import { Textarea } from '@/client/components/ui/textarea'
import { FormDialog } from '@/client/components/common/FormDialog'
import { FormField } from '@/client/components/common/FormField'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/client/components/ui/collapsible'
import { AgentSelector } from '@/client/components/common/AgentSelector'
import type { AgentOption } from '@/client/components/common/AgentSelectItem'
import { PlatformSelector } from '@/client/components/common/PlatformSelector'
import { DynamicField } from '@/client/components/common/DynamicField'
import { QrPairingView } from '@/client/components/channel/QrPairingView'
import { Button } from '@/client/components/ui/button'
import { AlertTriangle, ChevronRight, HelpCircle, Lightbulb, RefreshCw } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import { usePlatforms } from '@/client/hooks/usePlatforms'
import { useSSE } from '@/client/hooks/useSSE'
import { api, getErrorMessage } from '@/client/lib/api'
import type { ChannelConfigSchema, ChannelSummary } from '@/shared/types'

function PlatformSetupGuide({ platform }: { platform: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const steps = t(`settings.channels.setupGuide.${platform}.steps`, { returnObjects: true }) as string[]
  const tip = t(`settings.channels.setupGuide.${platform}.tip`)

  // Don't render setup guide if no translation exists (e.g. plugin platforms)
  const hasGuide = Array.isArray(steps) && steps.length > 0 && steps[0] !== `settings.channels.setupGuide.${platform}.steps`

  if (!hasGuide) return null

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors"
        >
          <HelpCircle className="size-3.5" />
          <span>{t('settings.channels.setupGuide.title')}</span>
          <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 rounded-lg border bg-muted/30 p-3 space-y-2.5 animate-in fade-in-0 slide-in-from-top-1">
          <p className="text-xs font-medium">
            {t(`settings.channels.setupGuide.${platform}.title`)}
          </p>
          <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal list-inside">
            {steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
          {tip && (
            <div className="flex items-start gap-1.5 text-xs text-muted-foreground/80 pt-1 border-t border-border/50">
              <Lightbulb className="size-3 mt-0.5 shrink-0 text-yellow-500" />
              <span>{tip}</span>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

interface ChannelFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (data: {
    agentId: string
    name: string
    platform: string
    platformConfig: Record<string, unknown>
  }) => Promise<void>
  /**
   * Patch handler for the in-place edits (name, allowedChatIds, etc).
   * Must NOT receive a agentId: the server now rejects PATCH /channels/:id
   * when agentId differs from the current binding; the dialog routes the
   * agent change through `onTransfer` instead.
   */
  onUpdate?: (channelId: string, data: { name?: string }) => Promise<void>
  /**
   * Transfer handler invoked when the user picks a different Agent in the
   * selector and saves. Fires POST /api/channels/:id/transfer through the
   * shared transferChannel service (system events, sideband hint, SSE,
   * adapter.onIdentityChange).
   */
  onTransfer?: (channelId: string, data: { targetAgentId: string; reason?: string }) => Promise<void>
  channel?: ChannelSummary | null
  agents: AgentOption[]
}

/**
 * Build the initial values record for an adapter's configSchema, applying
 * declared `default` values for fields the user hasn't touched yet.
 */
function buildInitialFormValues(schema: ChannelConfigSchema | undefined): Record<string, unknown> {
  if (!schema) return {}
  const values: Record<string, unknown> = {}
  for (const field of schema.fields) {
    if (field.default !== undefined) values[field.name] = field.default
  }
  return values
}

function isRequiredFieldMissing(value: unknown, type: string): boolean {
  if (value === undefined || value === null) return true
  if (type === 'switch') return false // booleans are always defined once initialized
  if (type === 'number') return typeof value === 'number' ? false : value === ''
  return typeof value === 'string' ? value.trim() === '' : false
}

export function ChannelFormDialog({
  open,
  onOpenChange,
  onSave,
  onUpdate,
  onTransfer,
  channel,
  agents,
}: ChannelFormDialogProps) {
  const { t } = useTranslation()
  const isEdit = !!channel
  const { platforms } = usePlatforms()

  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [name, setName] = useState('')
  const [platform, setPlatform] = useState('')
  const [formValues, setFormValues] = useState<Record<string, unknown>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Transfer reason (only used when the user changes the Agent on edit).
  const [transferReason, setTransferReason] = useState('')

  // ─── QR pairing (e.g. WhatsApp Web) ────────────────────────────────────────
  // Pairing platforms have no static config: after the channel is created we
  // activate it, the server streams a QR via `channel:pairing` SSE, and the
  // channel turns active once the user scans it.
  const [pairStep, setPairStep] = useState<'form' | 'qr' | 'connected'>('form')
  const [qrImage, setQrImage] = useState('')
  const [pairChannelId, setPairChannelId] = useState('')

  const resetPairing = () => {
    setPairStep('form')
    setQrImage('')
    setPairChannelId('')
  }

  // Agent change detection in edit mode: anything bound to onTransfer below.
  const agentChanged = isEdit && !!channel && selectedAgentId !== '' && selectedAgentId !== channel.agentId

  const activePlatform = useMemo(
    () => platforms.find((p) => p.platform === platform) ?? null,
    [platforms, platform],
  )
  const activeSchema = activePlatform?.configSchema
  const isPairingPlatform = !isEdit && activePlatform?.pairing === 'qr'

  // Listen for pairing lifecycle of the channel we just created.
  useSSE({
    'channel:pairing': (data) => {
      if (!pairChannelId || data.channelId !== pairChannelId) return
      const status = data.status as string
      if (status === 'qr') {
        setQrImage(String(data.qrImage ?? ''))
        setPairStep('qr')
      } else if (status === 'connected') {
        setPairStep('connected')
        // Give the user a beat to see the success state, then close. The
        // channels list refreshes itself off the channel:updated SSE event.
        setTimeout(() => onOpenChange(false), 1400)
      } else if (status === 'logged-out' || status === 'error') {
        setError(String(data.message ?? '') || t('settings.channels.qr.failed'))
        setPairStep('form')
      }
    },
  })

  // Set default platform when platforms load
  useEffect(() => {
    if (!platform && platforms.length > 0) {
      setPlatform(platforms[0]!.platform)
    }
  }, [platforms]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (channel) {
      setName(channel.name)
      setPlatform(channel.platform)
      setSelectedAgentId(channel.agentId)
      setFormValues({})
    } else {
      setName('')
      setPlatform(platforms[0]?.platform ?? '')
      setSelectedAgentId('')
      setFormValues({})
    }
    // Always reset the transfer reason when the dialog re-opens or the
    // edited channel changes; stale text from a previous edit must not
    // leak into a new transfer.
    setTransferReason('')
    setError(null)
    resetPairing()
  }, [channel, open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset form values to the active platform's schema defaults whenever
  // the platform changes (creation flow only).
  useEffect(() => {
    if (isEdit) return
    setFormValues(buildInitialFormValues(activeSchema))
  }, [platform, activeSchema, isEdit])

  const handleSave = async () => {
    setError(null)
    setIsLoading(true)

    try {
      if (isEdit && channel) {
        // Edit flow: name (and other patchable fields) go through PATCH;
        // the Agent change goes through the transfer endpoint so the system
        // events, sideband hint, SSE broadcast, and adapter identity
        // switch all fire. If both changed, PATCH first then transfer so
        // the audit-trail rows reference the final channel name.
        const nameChanged = name !== channel.name
        if (nameChanged && onUpdate) {
          await onUpdate(channel.id, { name })
        }
        if (agentChanged && onTransfer) {
          await onTransfer(channel.id, {
            targetAgentId: selectedAgentId,
            reason: transferReason.trim() ? transferReason.trim() : undefined,
          })
        }
      } else {
        if (!selectedAgentId) return
        await onSave({
          agentId: selectedAgentId,
          name,
          platform,
          platformConfig: formValues,
        })
      }
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }

  // Create the channel then activate it to begin QR pairing. The QR image and
  // the eventual "connected" arrive over the `channel:pairing` SSE handler above.
  const handlePairingStart = async () => {
    setError(null)
    setIsLoading(true)
    try {
      if (!selectedAgentId) return
      let channelId = pairChannelId
      if (!channelId) {
        const res = await api.post<{ channel: { id: string } }>('/channels', {
          agentId: selectedAgentId,
          name,
          platform,
          platformConfig: {},
        })
        channelId = res.channel.id
        setPairChannelId(channelId)
      }
      await api.post(`/channels/${channelId}/activate`)
      setPairStep('qr')
    } catch (err) {
      setError(getErrorMessage(err))
      setPairStep('form')
    } finally {
      setIsLoading(false)
    }
  }

  // Re-activate to request a fresh QR (the displayed one expires).
  const handleRegenerateQr = async () => {
    if (!pairChannelId) return
    setError(null)
    setQrImage('')
    try {
      await api.post(`/channels/${pairChannelId}/activate`)
    } catch (err) {
      setError(getErrorMessage(err))
    }
  }

  // Closing mid-pair (QR shown but not yet scanned) leaves the socket running —
  // deactivate it so we don't keep an unpaired connection alive.
  const handleOpenChange = (next: boolean) => {
    if (!next && pairChannelId && pairStep === 'qr') {
      void api.post(`/channels/${pairChannelId}/deactivate`).catch(() => {})
    }
    onOpenChange(next)
  }

  const requiredFieldsMissing = (activeSchema?.fields ?? [])
    .filter((f) => f.required)
    .some((f) => isRequiredFieldMissing(formValues[f.name], f.type))

  const canSubmit = isEdit
    ? !!name.trim()
    : !!name.trim() && !!selectedAgentId && !!platform && !requiredFieldsMissing

  return (
    <FormDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={isEdit ? t('common.edit') : t('settings.channels.add')}
      size="lg"
      error={error}
      onSubmit={
        isPairingPlatform
          ? (pairStep === 'form' ? handlePairingStart : pairStep === 'qr' ? handleRegenerateQr : undefined)
          : handleSave
      }
      isSubmitting={isLoading}
      submitDisabled={!canSubmit}
      submitLabel={
        isPairingPlatform && pairStep === 'form'
          ? t('settings.channels.qr.start')
          : t('common.save')
      }
      footer={
        isPairingPlatform && pairStep !== 'form' ? (
          <>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              {pairStep === 'connected' ? t('common.close') : t('common.cancel')}
            </Button>
            {pairStep === 'qr' && (
              <Button type="button" variant="secondary" onClick={handleRegenerateQr}>
                <RefreshCw className="size-4" />
                {t('settings.channels.qr.regenerate')}
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {/* QR pairing step (e.g. WhatsApp Web) */}
      {isPairingPlatform && pairStep !== 'form' && (
        <QrPairingView qrImage={qrImage} connected={pairStep === 'connected'} />
      )}

      {/* Form (hidden once QR pairing begins) */}
      {pairStep === 'form' && (
        <>
      {/* Name */}
      <FormField
        label={t('settings.channels.name')}
        htmlFor="channel-name"
        tip={t('settings.channels.nameTip')}
        required
      >
        <Input
          id="channel-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('settings.channels.namePlaceholder')}
          required
        />
      </FormField>

      {/* Agent selector */}
      <FormField
        label={t('settings.channels.agentLabel')}
        htmlFor="channel-agent"
        tip={t('settings.channels.agentTip')}
      >
        <AgentSelector
          value={selectedAgentId}
          onValueChange={setSelectedAgentId}
          agents={agents}
          placeholder={t('settings.channels.agentPlaceholder')}
        />
        {agentChanged && (
          <p className="flex items-start gap-1.5 text-xs text-warning">
            <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
            <span>{t('settings.channels.transferWarning', 'Selecting a different Agent will transfer this channel. The previous Agent loses the binding and both Agents get an audit-trail row in their conversation.')}</span>
          </p>
        )}
      </FormField>

      {/* Optional reason: only shown when the user picked a different Agent */}
      {agentChanged && (
        <FormField
          label={t('settings.channels.transferReasonLabel', 'Transfer reason (optional)')}
          htmlFor="channel-transfer-reason"
        >
          <Textarea
            id="channel-transfer-reason"
            value={transferReason}
            onChange={(e) => setTransferReason(e.target.value.slice(0, 200))}
            placeholder={t('settings.channels.transferReasonPlaceholder', "Optional note about why you're transferring this channel (200 chars max).")}
            rows={2}
            maxLength={200}
          />
          <p className="text-[10px] text-muted-foreground/70 text-right tabular-nums">
            {transferReason.length} / 200
          </p>
        </FormField>
      )}

      {/* Platform selector (only for create) */}
      {!isEdit && platforms.length > 0 && (
        <FormField label={t('settings.channels.platform')} htmlFor="channel-platform">
          <PlatformSelector
            value={platform}
            onValueChange={setPlatform}
          />
        </FormField>
      )}

      {/* Dynamic per-adapter config fields (only for create) */}
      {!isEdit && activeSchema && activeSchema.fields.length > 0 && (
        <div className="space-y-4">
          {activeSchema.fields.map((field) => (
            <DynamicField
              key={field.name}
              field={field}
              value={formValues[field.name]}
              onChange={(v) =>
                setFormValues((prev) => ({ ...prev, [field.name]: v }))
              }
            />
          ))}
          <PlatformSetupGuide platform={platform} />
        </div>
      )}
        </>
      )}
    </FormDialog>
  )
}
