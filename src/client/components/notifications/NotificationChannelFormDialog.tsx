import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { api, getErrorMessage } from '@/client/lib/api'
import { Input } from '@/client/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/client/components/ui/select'
import { FormDialog } from '@/client/components/common/FormDialog'
import { FormField } from '@/client/components/common/FormField'
import { PlatformIcon } from '@/client/components/common/PlatformIcon'
import type { NotificationChannelSummary, AvailableNotificationChannel, ContactForNotification } from '@/shared/types'

interface NotificationChannelFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editChannel?: NotificationChannelSummary | null
  onSaved: () => void
}

export function NotificationChannelFormDialog({ open, onOpenChange, editChannel, onSaved }: NotificationChannelFormDialogProps) {
  const { t } = useTranslation()
  const [availableChannels, setAvailableChannels] = useState<AvailableNotificationChannel[]>([])
  const [channelId, setChannelId] = useState('')
  const [contacts, setContacts] = useState<ContactForNotification[]>([])
  const [selectedContactId, setSelectedContactId] = useState('')
  const [label, setLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const selectedChannel = availableChannels.find((c) => c.channelId === channelId)

  // Fetch available channels on open
  useEffect(() => {
    if (open) {
      api.get<{ channels: AvailableNotificationChannel[] }>('/notifications/channels/available')
        .then((data) => setAvailableChannels(data.channels))
        .catch(() => {})

      if (editChannel) {
        setChannelId(editChannel.channelId)
        setLabel(editChannel.label ?? '')
        // We don't have contactId in edit mode — keep selectedContactId empty
        setSelectedContactId('')
      } else {
        setChannelId('')
        setSelectedContactId('')
        setLabel('')
      }
      setContacts([])
      setError('')
    }
  }, [open, editChannel])

  // Fetch contacts when channel (platform) changes
  useEffect(() => {
    if (!selectedChannel) {
      setContacts([])
      return
    }

    api.get<{ contacts: ContactForNotification[] }>(`/notifications/channels/contacts?platform=${selectedChannel.platform}`)
      .then((data) => {
        setContacts(data.contacts)
        // In edit mode, try to match the existing platformChatId to a contact
        if (editChannel) {
          const match = data.contacts.find((c) => c.platformId === editChannel.platformChatId)
          if (match) setSelectedContactId(match.contactId)
        }
      })
      .catch(() => setContacts([]))
  }, [selectedChannel?.channelId, selectedChannel?.platform, editChannel])

  const selectedContact = contacts.find((c) => c.contactId === selectedContactId)

  // Auto-fill label when contact is selected (only if label is empty)
  useEffect(() => {
    if (selectedContact && !label && !editChannel) {
      setLabel(selectedContact.contactName)
    }
  }, [selectedContact, editChannel]) // eslint-disable-line react-hooks/exhaustive-deps

  const platformChatId = selectedContact?.platformId ?? ''

  const handleSubmit = async () => {
    if (!channelId || !platformChatId) return

    setError('')
    setSaving(true)
    try {
      if (editChannel) {
        await api.patch(`/notifications/channels/${editChannel.id}`, {
          platformChatId,
          label: label || undefined,
        })
      } else {
        await api.post('/notifications/channels', {
          channelId,
          platformChatId,
          label: label || undefined,
        })
      }
      onSaved()
      onOpenChange(false)
    } catch (err: unknown) {
      setError(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={editChannel ? t('settings.notifications.editChannel') : t('settings.notifications.addChannel')}
      size="md"
      error={error}
      onSubmit={handleSubmit}
      isSubmitting={saving}
      submitDisabled={!channelId || !platformChatId}
      submitLabel={editChannel ? t('common.save') : t('common.create')}
    >
      {/* Source channel */}
      <FormField label={t('settings.notifications.sourceChannel')} tip={t('settings.notifications.sourceChannelTip')}>
        {availableChannels.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('settings.notifications.noAvailableChannels')}</p>
        ) : (
          <Select value={channelId} onValueChange={(v) => { setChannelId(v); setSelectedContactId('') }} disabled={!!editChannel}>
            <SelectTrigger>
              <SelectValue placeholder={t('settings.notifications.sourceChannel')} />
            </SelectTrigger>
            <SelectContent>
              {availableChannels.map((ch) => (
                <SelectItem key={ch.channelId} value={ch.channelId}>
                  <div className="flex items-center gap-2">
                    <PlatformIcon platform={ch.platform} variant="color" className="size-4" />
                    <span>{ch.channelName}</span>
                    <span className="text-muted-foreground text-xs">({ch.agentName})</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormField>

      {/* Recipient (Contact) */}
      {selectedChannel && (
        <FormField label={t('settings.notifications.recipient')} tip={t('settings.notifications.recipientTip')}>
          {contacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('settings.notifications.noContactsForPlatform', { platform: selectedChannel.platform })}
            </p>
          ) : (
            <Select value={selectedContactId} onValueChange={setSelectedContactId}>
              <SelectTrigger>
                <SelectValue placeholder={t('settings.notifications.selectContact')} />
              </SelectTrigger>
              <SelectContent>
                {contacts.map((c) => (
                  <SelectItem key={c.contactId} value={c.contactId}>
                    <div className="flex items-center gap-2">
                      <span>{c.contactName}</span>
                      <span className="text-muted-foreground text-xs">({c.platformId})</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
      )}

      {/* Label */}
      <FormField label={t('settings.notifications.label')} htmlFor="notification-channel-label" tip={t('settings.notifications.labelTip')}>
        <Input
          id="notification-channel-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t('settings.notifications.labelPlaceholder')}
        />
      </FormField>
    </FormDialog>
  )
}
