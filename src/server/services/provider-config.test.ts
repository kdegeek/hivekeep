import { describe, it, expect, beforeEach, mock } from 'bun:test'

// ─── Mocks ───────────────────────────────────────────────────────────────────
// In-memory vault: createSecret stores, getSecretValue reads, etc. Secret ids
// are derived from the key so deleteSecret(id) can map back to the entry.
const vaultStore = new Map<string, string>()
const idOf = (key: string) => `id::${key}`
const keyOf = (id: string) => id.slice('id::'.length)

const mockVault = {
  createSecret: mock(async (key: string, value: string) => {
    vaultStore.set(key, value)
    return { id: idOf(key), key, createdAt: new Date() }
  }),
  getSecretByKey: mock(async (key: string) =>
    vaultStore.has(key) ? { id: idOf(key), key } : undefined,
  ),
  getSecretValue: mock(async (key: string) => (vaultStore.has(key) ? vaultStore.get(key)! : null)),
  updateSecretValueByKey: mock(async (key: string, value: string) => {
    if (!vaultStore.has(key)) return null
    vaultStore.set(key, value)
    return { id: idOf(key), key, updatedAt: new Date() }
  }),
  deleteSecret: mock(async (id: string) => vaultStore.delete(keyOf(id))),
}
mock.module('@/server/services/vault', () => mockVault)

// Identity encryption → configEncrypted holds plain JSON in these tests.
mock.module('@/server/services/encryption', () => ({
  encrypt: async (s: string) => s,
  decrypt: async (s: string) => s,
}))

// Only `openai`/`anthropic` declare a secret field (`apiKey`) in these tests.
mock.module('@/server/providers/index', () => ({
  getSecretFieldKeys: (type: string) => (type === 'openai' || type === 'anthropic' ? ['apiKey'] : []),
}))

mock.module('@/server/logger', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}))

// migrate* touches the DB; not exercised here — stub so the import doesn't
// open the real database.
mock.module('@/server/db/index', () => ({ db: {} }))
mock.module('@/server/db/schema', () => ({ providers: {} }))

const {
  vaultifyProviderConfig,
  hydrateProviderConfig,
  loadProviderConfig,
  deleteProviderVaultSecrets,
  isVaultRef,
  providerVaultKey,
  VAULT_REF_PREFIX,
} = await import('@/server/services/provider-config')

const REF = (type: string, id: string, field: string) => VAULT_REF_PREFIX + providerVaultKey(type, id, field)

beforeEach(() => {
  vaultStore.clear()
})

describe('provider-config vault bridge', () => {
  it('vaultify moves secret fields into the vault and leaves non-secret fields inline', async () => {
    const out = await vaultifyProviderConfig('openai', 'p1', { apiKey: 'sk-123', baseUrl: 'https://api.x' })
    expect(out.baseUrl).toBe('https://api.x')
    expect(out.apiKey).toBe(REF('openai', 'p1', 'apiKey'))
    expect(isVaultRef(out.apiKey)).toBe(true)
    expect(vaultStore.get(providerVaultKey('openai', 'p1', 'apiKey'))).toBe('sk-123')
  })

  it('hydrate resolves $vault: refs back to the real values (round-trip)', async () => {
    const out = await vaultifyProviderConfig('openai', 'p1', { apiKey: 'sk-123', baseUrl: 'https://api.x' })
    const hydrated = await hydrateProviderConfig(out)
    expect(hydrated).toEqual({ apiKey: 'sk-123', baseUrl: 'https://api.x' })
  })

  it('loadProviderConfig decrypts + hydrates a stored row', async () => {
    const out = await vaultifyProviderConfig('openai', 'p1', { apiKey: 'sk-123', baseUrl: 'https://api.x' })
    const cfg = await loadProviderConfig({ configEncrypted: JSON.stringify(out) })
    expect(cfg.apiKey).toBe('sk-123')
    expect(cfg.baseUrl).toBe('https://api.x')
  })

  it('is idempotent: re-vaultifying a config that already holds refs is a no-op', async () => {
    const out = await vaultifyProviderConfig('openai', 'p1', { apiKey: 'sk-123' })
    const again = await vaultifyProviderConfig('openai', 'p1', out)
    expect(again.apiKey).toBe(out.apiKey)
    expect(vaultStore.size).toBe(1) // no duplicate entry
  })

  it('rotates a key in place (same vault key, new value, same ref)', async () => {
    const out = await vaultifyProviderConfig('openai', 'p1', { apiKey: 'sk-old', baseUrl: 'https://api.x' })
    const rotated = await vaultifyProviderConfig('openai', 'p1', { apiKey: 'sk-new', baseUrl: 'https://api.x' })
    expect(rotated.apiKey).toBe(out.apiKey)
    expect(vaultStore.get(providerVaultKey('openai', 'p1', 'apiKey'))).toBe('sk-new')
    expect(vaultStore.size).toBe(1)
  })

  it('leaves types without a secret field untouched', async () => {
    const out = await vaultifyProviderConfig('some-oauth-type', 'p2', { token: 'abc', region: 'eu' })
    expect(out).toEqual({ token: 'abc', region: 'eu' })
    expect(vaultStore.size).toBe(0)
  })

  it('drops empty/absent secret values rather than storing them', async () => {
    const out = await vaultifyProviderConfig('openai', 'p3', { apiKey: '', baseUrl: 'https://api.x' })
    expect('apiKey' in out).toBe(false)
    expect(out.baseUrl).toBe('https://api.x')
    expect(vaultStore.size).toBe(0)
  })

  it('deleteProviderVaultSecrets removes the referenced vault entries', async () => {
    const out = await vaultifyProviderConfig('openai', 'p1', { apiKey: 'sk-123', baseUrl: 'https://api.x' })
    expect(vaultStore.size).toBe(1)
    await deleteProviderVaultSecrets({ configEncrypted: JSON.stringify(out) })
    expect(vaultStore.has(providerVaultKey('openai', 'p1', 'apiKey'))).toBe(false)
  })

  it('hydrate omits a field whose vault secret is missing (no ref leak)', async () => {
    const hydrated = await hydrateProviderConfig({ apiKey: REF('openai', 'gone', 'apiKey'), baseUrl: 'https://api.x' })
    expect('apiKey' in hydrated).toBe(false)
    expect(hydrated.baseUrl).toBe('https://api.x')
  })

  it('loadProviderConfig returns {} for an empty/garbage blob', async () => {
    expect(await loadProviderConfig({ configEncrypted: null })).toEqual({})
    expect(await loadProviderConfig({ configEncrypted: 'not-json' })).toEqual({})
  })
})
