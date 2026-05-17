import { registerImageProvider } from '@/server/llm/image/registry'
import { openaiImageProvider } from '@/server/llm/image/openai'

/**
 * Register every built-in image-generation provider in the registry. Called
 * once at server startup, after the LLM provider registration.
 */
export function registerBuiltinImageProviders(): void {
  registerImageProvider(openaiImageProvider)
}
