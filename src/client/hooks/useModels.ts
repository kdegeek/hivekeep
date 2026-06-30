import { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '@/client/lib/api'
import { useSSE } from '@/client/hooks/useSSE'
import type { AgentThinkingEffort } from '@/shared/types'

const MODEL_FETCH_TIMEOUT_MS = 10_000

/** Model as returned by GET /api/providers/models */
export interface ProviderModel {
  id: string
  name: string
  providerId: string
  providerName: string
  providerType: string
  capability: string
  /** LLM-family only — chat accepts image attachments. (Tri-state: true /
   *  false = explicitly not / undefined = unknown.) */
  supportsImageInput?: boolean
  /** LLM-family only — chat accepts PDF attachments. Same tri-state. */
  supportsPdfInput?: boolean
  /** Image-family only — how many source images the model accepts
   *  (0 = text-to-image, 1 = single-image edit, N>1 = multi-reference). */
  maxImageInputs?: number
  /** Maximum input/context tokens. Populated when the provider's API exposes it. */
  contextWindow?: number
  /** Maximum output tokens. Populated when the provider's API exposes it. */
  maxOutput?: number
  /** LLM-family only — reasoning support after registry enrichment.
   *  Absent = not a reasoning model (or unknown); `efforts: []` = reasoning
   *  toggle-only (no granularity). Drives the effort selectors. */
  thinking?: { efforts: AgentThinkingEffort[]; note?: string }
}

interface RegistryModel {
  modelId: string
  displayName: string | null
  providerId: string
  providerName: string | null
  providerType: string | null
  contextWindow: number | null
  maxOutput: number | null
  supportsImageInput: boolean | null
  supportsPdfInput: boolean | null
  reasoning: { enabled: boolean; efforts: AgentThinkingEffort[] } | null
  enabled: boolean
  stale: boolean
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Model list request timed out')), ms)
    promise.then(
      (value) => {
        window.clearTimeout(timeout)
        resolve(value)
      },
      (err) => {
        window.clearTimeout(timeout)
        reject(err)
      },
    )
  })
}

function registryRowsToModels(rows: RegistryModel[]): ProviderModel[] {
  return rows
    .filter((row) => row.enabled && !row.stale)
    .map((row) => ({
      id: row.modelId,
      name: row.displayName ?? row.modelId,
      providerId: row.providerId,
      providerName: row.providerName ?? row.providerId,
      providerType: row.providerType ?? '',
      capability: 'llm',
      ...(row.contextWindow != null ? { contextWindow: row.contextWindow } : {}),
      ...(row.maxOutput != null ? { maxOutput: row.maxOutput } : {}),
      ...(row.supportsImageInput !== null ? { supportsImageInput: row.supportsImageInput } : {}),
      ...(row.supportsPdfInput !== null ? { supportsPdfInput: row.supportsPdfInput } : {}),
      ...(row.reasoning?.enabled ? { thinking: { efforts: row.reasoning.efforts } } : {}),
    }))
}

/**
 * Shared hook to fetch all available provider models.
 * Replaces inline fetches in GeneralSettings, StepProviders, and useAgents.
 */
export function useModels() {
  const [models, setModels] = useState<ProviderModel[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const fetchModels = useCallback(async () => {
    setIsLoading(true)
    try {
      const data = await withTimeout(
        api.get<{ models: ProviderModel[] }>('/providers/models'),
        MODEL_FETCH_TIMEOUT_MS,
      )
      setModels(data.models)
    } catch (err) {
      console.error('Failed to fetch models:', err)
      try {
        const data = await api.get<{ models: RegistryModel[] }>('/models')
        setModels((prev) => [
          ...prev.filter((model) => model.capability !== 'llm'),
          ...registryRowsToModels(data.models),
        ])
      } catch (fallbackErr) {
        console.error('Failed to fetch registry models:', fallbackErr)
        setModels([])
      }
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  // Refresh model list when providers change
  useSSE({
    'provider:created': () => fetchModels(),
    'provider:updated': () => fetchModels(),
    'provider:deleted': () => fetchModels(),
  })

  const llmModels = useMemo(() => models.filter((m) => m.capability === 'llm'), [models])
  const imageModels = useMemo(() => models.filter((m) => m.capability === 'image'), [models])
  const embeddingModels = useMemo(() => models.filter((m) => m.capability === 'embedding'), [models])

  return {
    models,
    llmModels,
    imageModels,
    embeddingModels,
    isLoading,
    refetch: fetchModels,
  }
}
