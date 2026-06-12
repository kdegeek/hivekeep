import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api, getErrorMessage } from '@/client/lib/api'
import type { ProviderData } from '@/client/components/agent/ProviderCard'

export interface TestAllState {
  running: boolean
  tested: number
  total: number
  results: Map<string, boolean>
}

interface UseProviderActionsOptions {
  providers: ProviderData[]
  refetch: () => Promise<void>
  /** Called after a successful delete (e.g. to clear default provider). */
  onDeleted?: (id: string) => void
}

export function useProviderActions({ providers, refetch, onDeleted }: UseProviderActionsOptions) {
  const { t } = useTranslation()
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testAllState, setTestAllState] = useState<TestAllState | null>(null)
  const [editingProvider, setEditingProvider] = useState<ProviderData | null>(null)
  const [modalOpen, setModalOpen] = useState(false)

  const handleTestAll = useCallback(async () => {
    if (providers.length === 0) return
    const results = new Map<string, boolean>()
    setTestAllState({ running: true, tested: 0, total: providers.length, results })

    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i]!
      try {
        const result = await api.post<{ valid: boolean }>(`/providers/${provider.id}/test`)
        results.set(provider.id, result.valid)
      } catch {
        results.set(provider.id, false)
      }
      setTestAllState({ running: true, tested: i + 1, total: providers.length, results: new Map(results) })
    }

    await refetch()

    const passed = [...results.values()].filter(Boolean).length
    const failed = results.size - passed
    setTestAllState({ running: false, tested: providers.length, total: providers.length, results: new Map(results) })

    if (failed === 0) {
      toast.success(t('settings.providers.testAllSuccess', { count: passed }))
    } else {
      toast.warning(t('settings.providers.testAllPartial', { passed, failed }))
    }

    setTimeout(() => setTestAllState(null), 5000)
  }, [providers, refetch, t])

  const handleTestProvider = useCallback(async (id: string) => {
    setTestingId(id)
    try {
      const result = await api.post<{ valid: boolean; error?: string }>(`/providers/${id}/test`)
      await refetch()
      if (result.valid) {
        toast.success(t('onboarding.providers.testSuccess'))
      } else {
        toast.error(result.error || t('onboarding.providers.testFailed'))
      }
    } catch {
      toast.error(t('onboarding.providers.testFailed'))
    } finally {
      setTestingId(null)
    }
  }, [refetch, t])

  const handleDeleteProvider = useCallback(async (id: string) => {
    try {
      await api.delete(`/providers/${id}`)
      onDeleted?.(id)
      await refetch()
      toast.success(t('settings.providers.deleted'))
    } catch (err: unknown) {
      toast.error(getErrorMessage(err))
    }
  }, [refetch, onDeleted, t])

  const handleProviderSaved = useCallback(async () => {
    await refetch()
    toast.success(editingProvider ? t('settings.providers.saved') : t('settings.providers.added'))
  }, [refetch, editingProvider, t])

  const openAdd = useCallback(() => {
    setEditingProvider(null)
    setModalOpen(true)
  }, [])

  const openEdit = useCallback((provider: ProviderData) => {
    setEditingProvider(provider)
    setModalOpen(true)
  }, [])

  return {
    testingId,
    testAllState,
    editingProvider,
    modalOpen,
    setModalOpen,
    handleTestAll,
    handleTestProvider,
    handleDeleteProvider,
    handleProviderSaved,
    openAdd,
    openEdit,
  }
}
