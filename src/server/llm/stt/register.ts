import { registerSTTProvider } from '@/server/llm/stt/registry'
import { openaiSTTProvider } from '@/server/llm/stt/openai'

/**
 * Register every built-in STT provider in the registry. Called once at
 * server startup, after the TTS provider registration.
 *
 * Plugin-contributed STT providers (Voxtral via the Mistral plugin,
 * Deepgram, …) are registered by the plugin loader regardless of
 * which built-ins exist.
 */
export function registerBuiltinSTTProviders(): void {
  registerSTTProvider(openaiSTTProvider)
}
