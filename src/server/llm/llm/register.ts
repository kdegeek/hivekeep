import { registerLLMProvider } from '@/server/llm/llm/registry'
import { anthropicKeyProvider } from '@/server/llm/llm/anthropic-key'
import { anthropicOAuthProvider } from '@/server/llm/llm/anthropic-oauth'
import { openaiKeyProvider } from '@/server/llm/llm/openai-key'
import { openaiCodexProvider } from '@/server/llm/llm/openai-codex'
import { geminiProvider } from '@/server/llm/llm/gemini'
import { openrouterProvider } from '@/server/llm/llm/openrouter'
import { xaiProvider } from '@/server/llm/llm/xai'
import { deepseekProvider } from '@/server/llm/llm/deepseek'
import { minimaxProvider } from '@/server/llm/llm/minimax'

/**
 * Register every built-in LLM provider in the registry. Called once at
 * server startup before any code that may resolve a provider by type.
 */
export function registerBuiltinLLMProviders(): void {
  registerLLMProvider(anthropicKeyProvider)
  registerLLMProvider(anthropicOAuthProvider)
  registerLLMProvider(openaiKeyProvider)
  registerLLMProvider(openaiCodexProvider)
  registerLLMProvider(geminiProvider)
  registerLLMProvider(openrouterProvider)
  registerLLMProvider(xaiProvider)
  registerLLMProvider(deepseekProvider)
  registerLLMProvider(minimaxProvider)
}
