import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { appSettings } from '@/server/db/schema'
import { createLogger } from '@/server/logger'

const log = createLogger('app-settings')

// In-memory cache (single-process, invalidated on write)
const cache = new Map<string, string>()

export async function getSetting(key: string): Promise<string | null> {
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const row = db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .get()

  if (row) {
    cache.set(key, row.value)
    return row.value
  }

  return null
}

export async function setSetting(key: string, value: string): Promise<void> {
  const now = Date.now()

  db.insert(appSettings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: now },
    })
    .run()

  cache.set(key, value)
  log.info({ key }, 'Setting updated')
}

export async function deleteSetting(key: string): Promise<void> {
  db.delete(appSettings).where(eq(appSettings.key, key)).run()
  cache.delete(key)
  log.info({ key }, 'Setting deleted')
}

export async function getGlobalPrompt(): Promise<string | null> {
  return getSetting('global_prompt')
}

export async function setGlobalPrompt(value: string): Promise<void> {
  return setSetting('global_prompt', value)
}

export async function getExtractionModel(): Promise<string | null> {
  return getSetting('extraction_model')
}

export async function setExtractionModel(model: string): Promise<void> {
  return setSetting('extraction_model', model)
}

export async function getEmbeddingModel(): Promise<string | null> {
  return getSetting('embedding_model')
}

export async function setEmbeddingModel(model: string): Promise<void> {
  return setSetting('embedding_model', model)
}

export async function getExtractionProviderId(): Promise<string | null> {
  return getSetting('extraction_provider_id')
}

export async function setExtractionProviderId(providerId: string | null): Promise<void> {
  if (providerId === null) return deleteSetting('extraction_provider_id')
  return setSetting('extraction_provider_id', providerId)
}

export async function getEmbeddingProviderId(): Promise<string | null> {
  return getSetting('embedding_provider_id')
}

export async function setEmbeddingProviderId(providerId: string | null): Promise<void> {
  if (providerId === null) return deleteSetting('embedding_provider_id')
  return setSetting('embedding_provider_id', providerId)
}

// ─── Default LLM (for new kins) ──────────────────────────────────────────────

export async function getDefaultLlmModel(): Promise<string | null> {
  return getSetting('default_llm_model')
}

export async function setDefaultLlmModel(model: string | null): Promise<void> {
  if (model === null) return deleteSetting('default_llm_model')
  return setSetting('default_llm_model', model)
}

export async function getDefaultLlmProviderId(): Promise<string | null> {
  return getSetting('default_llm_provider_id')
}

export async function setDefaultLlmProviderId(providerId: string | null): Promise<void> {
  if (providerId === null) return deleteSetting('default_llm_provider_id')
  return setSetting('default_llm_provider_id', providerId)
}

// ─── Default Image Model ─────────────────────────────────────────────────────

export async function getDefaultImageModel(): Promise<string | null> {
  return getSetting('default_image_model')
}

export async function setDefaultImageModel(model: string | null): Promise<void> {
  if (model === null) return deleteSetting('default_image_model')
  return setSetting('default_image_model', model)
}

export async function getDefaultImageProviderId(): Promise<string | null> {
  return getSetting('default_image_provider_id')
}

export async function setDefaultImageProviderId(providerId: string | null): Promise<void> {
  if (providerId === null) return deleteSetting('default_image_provider_id')
  return setSetting('default_image_provider_id', providerId)
}

// ─── Default Search Provider ─────────────────────────────────────────────────

/**
 * Default search provider used by `web_search` when the LLM doesn't
 * pass an explicit `providerSlug`. Stored as the provider's UUID (same
 * convention as default_llm_provider_id). The `web_search` tool resolves
 * the row at call time and exposes it to the LLM as a slug for
 * human-readable tool input.
 *
 * No `default_search_model` companion: search providers have no model
 * selection (one provider == one search endpoint).
 */
export async function getDefaultSearchProviderId(): Promise<string | null> {
  return getSetting('default_search_provider_id')
}

export async function setDefaultSearchProviderId(providerId: string | null): Promise<void> {
  if (providerId === null) return deleteSetting('default_search_provider_id')
  return setSetting('default_search_provider_id', providerId)
}

// ─── Default TTS Provider ────────────────────────────────────────────────────

/**
 * Default TTS provider used by `text_to_speech` when the LLM doesn't
 * pass an explicit provider slug. Voice selection is independent — the
 * tool always takes an explicit `voice_id` (and `provider_slug` when
 * cross-provider).
 *
 * No `default_tts_voice` companion: voices are per-tool-call (or per
 * channel config later), not per global default.
 */
export async function getDefaultTtsProviderId(): Promise<string | null> {
  return getSetting('default_tts_provider_id')
}

export async function setDefaultTtsProviderId(providerId: string | null): Promise<void> {
  if (providerId === null) return deleteSetting('default_tts_provider_id')
  return setSetting('default_tts_provider_id', providerId)
}

// ─── Default STT Provider ────────────────────────────────────────────────────

/**
 * Default STT provider used by `transcribe_audio` when the LLM doesn't
 * pass an explicit provider slug. The transcription model is picked at
 * call time (provider default unless the LLM overrides via model_id).
 */
export async function getDefaultSttProviderId(): Promise<string | null> {
  return getSetting('default_stt_provider_id')
}

export async function setDefaultSttProviderId(providerId: string | null): Promise<void> {
  if (providerId === null) return deleteSetting('default_stt_provider_id')
  return setSetting('default_stt_provider_id', providerId)
}

// ─── Default Compacting Model ────────────────────────────────────────────────

export async function getDefaultCompactingModel(): Promise<string | null> {
  return getSetting('default_compacting_model')
}

export async function setDefaultCompactingModel(model: string | null): Promise<void> {
  if (model === null) return deleteSetting('default_compacting_model')
  return setSetting('default_compacting_model', model)
}

export async function getDefaultCompactingProviderId(): Promise<string | null> {
  return getSetting('default_compacting_provider_id')
}

export async function setDefaultCompactingProviderId(providerId: string | null): Promise<void> {
  if (providerId === null) return deleteSetting('default_compacting_provider_id')
  return setSetting('default_compacting_provider_id', providerId)
}

