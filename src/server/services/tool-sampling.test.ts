import { describe, expect, it } from 'bun:test'
import { config } from '@/server/config'
import type { LLMModel } from '@/server/llm/llm/types'
import { toolTurnSampling } from './tool-sampling'

const plain: LLMModel = {
  id: 'gemma-12b',
  name: 'gemma-12b',
  supportsPromptCaching: false,
  supportsParallelTools: false,
}

const reasoning: LLMModel = {
  ...plain,
  id: 'o3',
  name: 'o3',
  thinking: { efforts: ['low', 'medium', 'high'] },
}

describe('toolTurnSampling', () => {
  it('omits temperature when no tools are attached', () => {
    expect(toolTurnSampling(plain, false)).toEqual({})
  })

  it('omits temperature for reasoning-capable models (they reject a custom temperature)', () => {
    expect(toolTurnSampling(reasoning, true)).toEqual({})
  })

  it('applies the configured temperature to a plain tool turn', () => {
    const result = toolTurnSampling(plain, true)
    if (config.tools.temperature == null) {
      expect(result).toEqual({})
    } else {
      expect(result).toEqual({ temperature: config.tools.temperature })
    }
  })
})
