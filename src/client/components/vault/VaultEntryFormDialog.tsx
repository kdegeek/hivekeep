import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/client/components/ui/input'
import { PasswordInput } from '@/client/components/ui/password-input'
import { Textarea } from '@/client/components/ui/textarea'
import { FormDialog } from '@/client/components/common/FormDialog'
import { FormField } from '@/client/components/common/FormField'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/client/components/ui/select'
import { api, getErrorMessage } from '@/client/lib/api'
import { VAULT_BUILTIN_TYPES, VAULT_TYPE_META } from '@/shared/constants'
import type { VaultTypeField, VaultTypeSummary } from '@/shared/types'
import type { VaultSecretData } from '@/client/components/vault/VaultSecretCard'
import { VaultAttachmentList } from '@/client/components/vault/VaultAttachmentList'

interface VaultEntryFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
  entry?: VaultSecretData | null
  customTypes?: VaultTypeSummary[]
}

export function VaultEntryFormDialog({
  open,
  onOpenChange,
  onSaved,
  entry,
  customTypes = [],
}: VaultEntryFormDialogProps) {
  const { t } = useTranslation()
  const isEditing = !!entry

  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')
  const [key, setKey] = useState('')
  const [entryType, setEntryType] = useState('text')
  const [description, setDescription] = useState('')
  const [allowedTools, setAllowedTools] = useState('')
  const [allowedHosts, setAllowedHosts] = useState('')
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})

  // Build type options
  const typeOptions = useMemo(() => {
    const options: Array<{ value: string; label: string }> = VAULT_BUILTIN_TYPES.map((type) => ({
      value: type,
      label: t(`vault.types.${type}`, type),
    }))
    for (const ct of customTypes) {
      options.push({ value: ct.slug, label: ct.name })
    }
    return options
  }, [t, customTypes])

  // Get fields for current entry type
  const fields = useMemo((): VaultTypeField[] => {
    const builtIn = VAULT_TYPE_META[entryType as keyof typeof VAULT_TYPE_META]
    if (builtIn) return builtIn.fields
    const custom = customTypes.find((ct) => ct.slug === entryType)
    if (custom) return custom.fields
    return VAULT_TYPE_META.text.fields
  }, [entryType, customTypes])

  // Reset form when dialog opens
  useEffect(() => {
    if (!open) return

    if (entry) {
      setKey(entry.key)
      setEntryType(entry.entryType ?? 'text')
      setDescription(entry.description ?? '')
      setAllowedTools((entry.allowedTools ?? []).join(', '))
      setAllowedHosts((entry.allowedHosts ?? []).join(', '))
      setFieldValues({})
      setError('')

      // Load current value for editing
      api.get<{ entryType: string; value: string | Record<string, unknown> }>(`/vault/entries/${entry.id}`)
        .then((data) => {
          if (typeof data.value === 'string') {
            setFieldValues({ value: data.value })
          } else if (typeof data.value === 'object' && data.value !== null) {
            const vals: Record<string, string> = {}
            for (const [k, v] of Object.entries(data.value)) {
              vals[k] = String(v ?? '')
            }
            setFieldValues(vals)
          }
        })
        .catch(() => { /* ignore — user will re-enter values */ })
    } else {
      setKey('')
      setEntryType('text')
      setDescription('')
      setAllowedTools('')
      setAllowedHosts('')
      setFieldValues({})
      setError('')
    }
  }, [open, entry])

  const handleClose = () => {
    onOpenChange(false)
  }

  const handleFieldChange = (fieldName: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [fieldName]: value }))
  }

  const handleSave = async () => {
    setError('')
    setIsSaving(true)
    try {
      // Build value based on entry type
      let value: string | Record<string, unknown>
      if (entryType === 'text') {
        value = fieldValues.value ?? ''
      } else {
        const obj: Record<string, unknown> = {}
        for (const field of fields) {
          if (fieldValues[field.name] !== undefined && fieldValues[field.name] !== '') {
            obj[field.name] = fieldValues[field.name]
          }
        }
        value = obj
      }

      const parseList = (raw: string): string[] | null => {
        const list = raw.split(',').map((v) => v.trim()).filter(Boolean)
        return list.length > 0 ? list : null
      }
      const scopes = { allowedTools: parseList(allowedTools), allowedHosts: parseList(allowedHosts) }

      if (isEditing) {
        await api.patch(`/vault/entries/${entry.id}`, {
          value,
          ...(description !== (entry.description ?? '') ? { description } : {}),
          ...scopes,
        })
      } else {
        await api.post('/vault/entries', {
          key,
          entryType,
          value,
          ...(description ? { description } : {}),
          ...scopes,
        })
      }
      onSaved()
      handleClose()
    } catch (err: unknown) {
      setError(getErrorMessage(err))
    } finally {
      setIsSaving(false)
    }
  }

  // Validate: key required for new entries, at least one required field filled
  const canSave = useMemo(() => {
    if (!isEditing && !key.trim()) return false
    const requiredFields = fields.filter((f) => f.required)
    if (requiredFields.length > 0) {
      // For editing, allow saving even if we haven't loaded values yet (password fields)
      if (!isEditing) {
        return requiredFields.every((f) => (fieldValues[f.name] ?? '').trim() !== '')
      }
    }
    return true
  }, [isEditing, key, fields, fieldValues])

  return (
    <FormDialog
      open={open}
      onOpenChange={(v) => { if (!v) handleClose() }}
      title={isEditing ? t('settings.vault.edit') : t('settings.vault.add')}
      description={isEditing ? t('settings.vault.editHint') : t('settings.vault.addHint')}
      size="lg"
      error={error || null}
      onSubmit={handleSave}
      isSubmitting={isSaving}
      submitDisabled={!canSave}
      submitLabel={isEditing ? t('common.save') : t('settings.vault.add')}
      cancelLabel={t('common.cancel')}
    >
      {/* Entry type selector (only for new entries) */}
      {!isEditing && (
        <FormField
          label={t('settings.vault.entryType')}
          htmlFor="vault-entry-type"
          tip={t('settings.vault.entryTypeTip')}
        >
          <Select value={entryType} onValueChange={(v) => { setEntryType(v); setFieldValues({}) }}>
            <SelectTrigger id="vault-entry-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {typeOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      )}

      {/* Key field */}
      <FormField
        label={t('settings.vault.key')}
        htmlFor="vault-key"
        tip={t('settings.vault.keyTip')}
      >
        <Input
          id="vault-key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={t('settings.vault.keyPlaceholder')}
          disabled={isEditing}
          className="font-mono"
        />
      </FormField>

      {/* Dynamic fields based on entry type */}
      {fields.map((field) => (
        <FormField
          key={field.name}
          label={field.label}
          htmlFor={`vault-field-${field.name}`}
          required={field.required}
          hint={
            isEditing && field.type === 'password'
              ? `(${t('settings.vault.valueEditHint')})`
              : !field.required
                ? `(${t('common.optional')})`
                : undefined
          }
        >
          {field.type === 'textarea' ? (
            <Textarea
              id={`vault-field-${field.name}`}
              value={fieldValues[field.name] ?? ''}
              onChange={(e) => handleFieldChange(field.name, e.target.value)}
              placeholder={field.placeholder}
              rows={3}
            />
          ) : field.type === 'password' ? (
            <PasswordInput
              id={`vault-field-${field.name}`}
              value={fieldValues[field.name] ?? ''}
              onChange={(e) => handleFieldChange(field.name, e.target.value)}
              placeholder={field.placeholder ?? (isEditing ? '••••••••' : undefined)}
              autoComplete="off"
            />
          ) : (
            <Input
              id={`vault-field-${field.name}`}
              type={field.type === 'number' ? 'number' : 'text'}
              value={fieldValues[field.name] ?? ''}
              onChange={(e) => handleFieldChange(field.name, e.target.value)}
              placeholder={field.placeholder}
              autoComplete="off"
            />
          )}
        </FormField>
      ))}

      {/* Description */}
      <FormField
        label={t('settings.vault.descriptionLabel')}
        htmlFor="vault-description"
        tip={t('settings.vault.descriptionTip')}
        hint={`(${t('common.optional')})`}
      >
        <Input
          id="vault-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('settings.vault.descriptionPlaceholder')}
        />
      </FormField>

      {/* Agent usage restrictions (placeholder scoping) */}
      <FormField
        label={t('settings.vault.allowedTools')}
        htmlFor="vault-allowed-tools"
        tip={t('settings.vault.allowedToolsTip')}
        hint={`(${t('common.optional')})`}
      >
        <Input
          id="vault-allowed-tools"
          value={allowedTools}
          onChange={(e) => setAllowedTools(e.target.value)}
          placeholder="http_request, run_shell"
          className="font-mono"
          autoComplete="off"
        />
      </FormField>
      <FormField
        label={t('settings.vault.allowedHosts')}
        htmlFor="vault-allowed-hosts"
        tip={t('settings.vault.allowedHostsTip')}
        hint={`(${t('common.optional')})`}
      >
        <Input
          id="vault-allowed-hosts"
          value={allowedHosts}
          onChange={(e) => setAllowedHosts(e.target.value)}
          placeholder="api.github.com, *.example.com"
          className="font-mono"
          autoComplete="off"
        />
      </FormField>

      {/* Attachments (only for existing entries) */}
      {isEditing && entry && (
        <VaultAttachmentList entryId={entry.id} />
      )}
    </FormDialog>
  )
}
