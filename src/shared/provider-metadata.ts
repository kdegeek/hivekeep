/**
 * Single source of truth for provider static metadata.
 *
 * Both the client (via constants.ts) and the server (via providers/index.ts)
 * derive their data from here. Adding a new provider = one entry here
 * + the provider implementation file.
 */
import type { ProviderCapability } from '@/shared/types'

export interface ProviderMeta {
  readonly capabilities: readonly ProviderCapability[]
  readonly displayName: string
  /** True when no API key is required (local or auto-detected credentials) */
  readonly noApiKey?: boolean
  /** True when the API key is optional (provider works without one, but supports one) */
  readonly optionalApiKey?: boolean
  /** URL where users can obtain or manage their API key */
  readonly apiKeyUrl?: string
  /**
   * Name of the icon to use from `@lobehub/icons` (e.g. `"Claude"`, `"OpenAI"`).
   * Must match the whitelist in the frontend's ProviderIcon component.
   * Falls back to a generic chip icon when missing or unsupported.
   */
  readonly lobehubIcon?: string
}

export const PROVIDER_META = {
  anthropic:          { capabilities: ['llm'],                       displayName: 'Anthropic',              lobehubIcon: 'Claude',  apiKeyUrl: 'https://console.anthropic.com/settings/keys' },
  'anthropic-oauth':  { capabilities: ['llm'],                       displayName: 'Anthropic (Claude Max)', lobehubIcon: 'Claude',  noApiKey: true },
  openai:             { capabilities: ['llm', 'embedding', 'image'], displayName: 'OpenAI',                 lobehubIcon: 'OpenAI',  apiKeyUrl: 'https://platform.openai.com/api-keys' },
  'openai-codex':     { capabilities: ['llm'],                       displayName: 'OpenAI (Codex CLI)',     lobehubIcon: 'OpenAI',  noApiKey: true },
  gemini:             { capabilities: ['llm', 'image'],              displayName: 'Google Gemini',          lobehubIcon: 'Gemini',  apiKeyUrl: 'https://aistudio.google.com/apikey' },
  'brave-search':     { capabilities: ['search'],                    displayName: 'Brave Search',                                   apiKeyUrl: 'https://brave.com/search/api/' },
} as const satisfies Record<string, ProviderMeta>

export type ProviderType = keyof typeof PROVIDER_META
