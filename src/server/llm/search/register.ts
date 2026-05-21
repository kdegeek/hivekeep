import { registerSearchProvider } from '@/server/llm/search/registry'
import { braveSearchProvider } from '@/server/llm/search/brave'

/**
 * Register every built-in search provider in the registry. Called once at
 * server startup, after the image provider registration.
 *
 * Plugin-contributed search providers are registered by the plugin
 * loader regardless of which built-ins exist.
 */
export function registerBuiltinSearchProviders(): void {
  registerSearchProvider(braveSearchProvider)
}
