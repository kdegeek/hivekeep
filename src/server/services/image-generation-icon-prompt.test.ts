import { describe, expect, it, mock } from 'bun:test'
import { fullMockConfig } from '../../test-helpers'

mock.module('@/server/db/index', () => ({
  db: {},
}))

// Use the real schema module rather than a partial mock. image-generation imports
// provider-config, which imports services/vault via the OAuth cleanup path; a
// partial schema mock without `vaultSecrets` can break that transitive import.
const _realDbSchema = await import('@/server/db/schema')
mock.module('@/server/db/schema', () => ({
  ..._realDbSchema,
}))

mock.module('@/server/logger', () => ({
  createLogger: () => ({
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  }),
}))

mock.module('@/server/config', () => ({
  config: {
    ...fullMockConfig,
    upload: { ...fullMockConfig.upload, dir: '/tmp/test-uploads' },
  },
}))

mock.module('@/server/services/app-settings', () => ({
  getDefaultImageModel: mock(() => Promise.resolve(null)),
  getDefaultImageProviderId: mock(() => Promise.resolve(null)),
  getSetting: mock(() => Promise.resolve(null)),
}))

mock.module('@/server/services/token-usage', () => ({
  recordUsage: mock(),
}))

mock.module('@/server/llm/core/resolve', () => ({
  pickAnyLLMModel: mock(() => Promise.resolve({
    provider: {},
    model: { id: 'bad-chat-model' },
    config: {},
    providerRow: { id: 'provider-id', type: 'test-provider' },
  })),
}))

mock.module('@/server/llm/core/run-oneshot', () => ({
  runOneShot: mock(() => Promise.reject(new Error('upstream prompt model rejected request'))),
}))

const { buildMiniAppIconPrompt } = await import('./image-generation')

describe('buildMiniAppIconPrompt', () => {
  it('falls back to a static prompt when the helper LLM call fails', async () => {
    const prompt = await buildMiniAppIconPrompt({
      name: 'Restart Hivekeep',
      description: 'Restart the Hivekeep launchd process.',
      icon: '🔁',
    })

    expect(prompt).toContain('Flat design app icon for "Restart Hivekeep"')
    expect(prompt).toContain('No text, no letters, no words, no UI elements')
  })
})
