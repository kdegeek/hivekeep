import { config } from '@/server/config'
import type { LLMModel } from '@/server/llm/llm/types'

/**
 * Sampling overrides for a tool-enabled turn.
 *
 * Self-hosted backends (Ollama, llama.cpp, LM Studio) default to a high temperature
 * (~0.7-0.8) that makes small models emit unreliable structured tool-call JSON. Hivekeep
 * never set a temperature, so those defaults applied even to tool turns. This pins the
 * low value from `config.tools.temperature` (settable via TOOLS_TEMPERATURE, `off` to
 * defer to the backend).
 *
 * Reasoning-capable models are exempted: OpenAI o-series reject any non-default
 * `temperature` with a 400, and Anthropic requires `temperature` to be 1 when extended
 * thinking is on. Those models advertise `thinking.efforts`; small / local models do not,
 * so they are exactly the ones this helps and the risky models are left untouched.
 */
export function toolTurnSampling(model: LLMModel, hasTools: boolean): { temperature?: number } {
  const temperature = config.tools.temperature
  if (!hasTools || temperature == null || !Number.isFinite(temperature)) return {}
  if (model.thinking?.efforts?.length) return {}
  return { temperature }
}
