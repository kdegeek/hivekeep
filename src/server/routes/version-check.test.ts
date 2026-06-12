import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { fullMockSchema, fullMockDrizzleOrm, fullMockConfig } from '../../test-helpers'

// ─── Mocks ──────────────────────────────────────────────────────────────────

let mockDbSelectGetResult: unknown = undefined

mock.module('drizzle-orm', () => fullMockDrizzleOrm)

mock.module('@/server/db/index', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          get: () => mockDbSelectGetResult,
        }),
      }),
    }),
  },
}))

mock.module('@/server/db/schema', () => ({
  ...fullMockSchema,
  userProfiles: { userId: 'userId', role: 'role' },
}))

const sampleInfo = {
  currentVersion: '1.0.0',
  currentSha: 'abc1234',
  channel: 'stable',
  installationType: 'systemd-system',
  latestVersion: '1.1.0',
  isUpdateAvailable: true,
  canSelfUpdate: true,
  selfUpdateBlockedReason: null,
  releaseUrl: 'https://github.com/MarlBurroW/hivekeep/releases/tag/v1.1.0',
  changelog: [
    { version: '1.1.0', title: 'Hivekeep v1.1.0', notes: 'Bug fixes', url: null, publishedAt: 1 },
  ],
  publishedAt: 1,
  lastCheckedAt: Date.now(),
}

const mockCheckForUpdates = mock(() => Promise.resolve(sampleInfo))
const mockGetCachedVersionInfo = mock(() =>
  Promise.resolve({ ...sampleInfo, isUpdateAvailable: false, latestVersion: '1.0.0' }),
)
const mockGetUpdateChannel = mock(() => Promise.resolve('stable'))
const mockSetUpdateChannel = mock(() => Promise.resolve())

mock.module('@/server/services/version-check', () => ({
  checkForUpdates: mockCheckForUpdates,
  getCachedVersionInfo: mockGetCachedVersionInfo,
  getUpdateChannel: mockGetUpdateChannel,
  setUpdateChannel: mockSetUpdateChannel,
}))

let mockStartResult: { ok: boolean; runId?: string; error?: { code: string; message: string } } = {
  ok: true,
  runId: 'run-1234',
}
const mockStartSelfUpdate = mock(() => Promise.resolve(mockStartResult))
let mockLastRun: unknown = null
const mockGetLastUpdateRun = mock(() => mockLastRun)

mock.module('@/server/services/self-update', () => ({
  startSelfUpdate: mockStartSelfUpdate,
  getLastUpdateRun: mockGetLastUpdateRun,
}))

const testConfig: Record<string, any> = {
  ...fullMockConfig,
  versionCheck: { ...fullMockConfig.versionCheck },
  environment: { ...(fullMockConfig as any).environment, installationType: 'systemd-system' },
}

mock.module('@/server/config', () => ({
  config: testConfig,
}))

// ─── App setup ──────────────────────────────────────────────────────────────

async function createApp() {
  const { versionCheckRoutes } = await import('./version-check')
  const app = new Hono()
  // Simulate auth middleware by injecting user
  app.use('*', async (c, next) => {
    c.set('user' as never, { id: 'test-user-id' } as never)
    await next()
  })
  app.route('/api/version-check', versionCheckRoutes)
  return app
}

function resetMocks() {
  mockCheckForUpdates.mockClear()
  mockGetCachedVersionInfo.mockClear()
  mockSetUpdateChannel.mockClear()
  mockStartSelfUpdate.mockClear()
  mockDbSelectGetResult = undefined
  mockStartResult = { ok: true, runId: 'run-1234' }
  mockLastRun = null
  testConfig.versionCheck = { ...fullMockConfig.versionCheck }
  testConfig.version = fullMockConfig.version
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/version-check', () => {
  beforeEach(resetMocks)

  it('returns disabled response when version check is disabled', async () => {
    testConfig.versionCheck.enabled = false
    const app = await createApp()
    const res = await app.request('/api/version-check')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.isUpdateAvailable).toBe(false)
    expect(body.latestVersion).toBeNull()
    expect(body.currentVersion).toBe(testConfig.version)
    expect(body.changelog).toEqual([])
    // Should NOT call getCachedVersionInfo when disabled
    expect(mockGetCachedVersionInfo).not.toHaveBeenCalled()
  })

  it('returns cached version info when enabled', async () => {
    testConfig.versionCheck.enabled = true
    const app = await createApp()
    const res = await app.request('/api/version-check')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.currentVersion).toBe('1.0.0') // comes from mock getCachedVersionInfo
    expect(body.isUpdateAvailable).toBe(false)
    expect(body.channel).toBe('stable')
    expect(mockGetCachedVersionInfo).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/version-check/check', () => {
  beforeEach(resetMocks)

  it('rejects non-admin users with 403', async () => {
    mockDbSelectGetResult = { role: 'member' }
    testConfig.versionCheck.enabled = true
    const app = await createApp()
    const res = await app.request('/api/version-check/check', { method: 'POST' })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('FORBIDDEN')
  })

  it('rejects when no profile found with 403', async () => {
    mockDbSelectGetResult = undefined
    testConfig.versionCheck.enabled = true
    const app = await createApp()
    const res = await app.request('/api/version-check/check', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  it('returns 400 when version check is disabled', async () => {
    mockDbSelectGetResult = { role: 'admin' }
    testConfig.versionCheck.enabled = false
    const app = await createApp()
    const res = await app.request('/api/version-check/check', { method: 'POST' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('DISABLED')
  })

  it('forces a fresh check for admin users', async () => {
    mockDbSelectGetResult = { role: 'admin' }
    testConfig.versionCheck.enabled = true
    const app = await createApp()
    const res = await app.request('/api/version-check/check', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.isUpdateAvailable).toBe(true)
    expect(body.latestVersion).toBe('1.1.0')
    expect(body.changelog).toHaveLength(1)
    expect(mockCheckForUpdates).toHaveBeenCalledTimes(1)
  })
})

describe('PUT /api/version-check/channel', () => {
  beforeEach(resetMocks)

  it('rejects non-admin users with 403', async () => {
    mockDbSelectGetResult = { role: 'member' }
    const app = await createApp()
    const res = await app.request('/api/version-check/channel', {
      method: 'PUT',
      body: JSON.stringify({ channel: 'edge' }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(403)
    expect(mockSetUpdateChannel).not.toHaveBeenCalled()
  })

  it('rejects an invalid channel with 400', async () => {
    mockDbSelectGetResult = { role: 'admin' }
    const app = await createApp()
    const res = await app.request('/api/version-check/channel', {
      method: 'PUT',
      body: JSON.stringify({ channel: 'nightly' }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVALID_CHANNEL')
    expect(mockSetUpdateChannel).not.toHaveBeenCalled()
  })

  it('saves the channel and re-checks for admin users', async () => {
    mockDbSelectGetResult = { role: 'admin' }
    testConfig.versionCheck.enabled = true
    const app = await createApp()
    const res = await app.request('/api/version-check/channel', {
      method: 'PUT',
      body: JSON.stringify({ channel: 'edge' }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(mockSetUpdateChannel).toHaveBeenCalledWith('edge')
    expect(mockCheckForUpdates).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/version-check/update', () => {
  beforeEach(resetMocks)

  it('rejects non-admin users with 403', async () => {
    mockDbSelectGetResult = { role: 'member' }
    const app = await createApp()
    const res = await app.request('/api/version-check/update', { method: 'POST' })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('FORBIDDEN')
    expect(mockStartSelfUpdate).not.toHaveBeenCalled()
  })

  it('rejects when no profile found with 403', async () => {
    mockDbSelectGetResult = undefined
    const app = await createApp()
    const res = await app.request('/api/version-check/update', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  it('returns 400 when self-update is unavailable (e.g. Docker)', async () => {
    mockDbSelectGetResult = { role: 'admin' }
    mockStartResult = {
      ok: false,
      error: { code: 'SELF_UPDATE_UNAVAILABLE', message: 'Docker installs update by pulling a newer image' },
    }
    const app = await createApp()
    const res = await app.request('/api/version-check/update', { method: 'POST' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SELF_UPDATE_UNAVAILABLE')
  })

  it('returns 409 when an update is already running', async () => {
    mockDbSelectGetResult = { role: 'admin' }
    mockStartResult = {
      ok: false,
      error: { code: 'UPDATE_IN_PROGRESS', message: 'An update is already running' },
    }
    const app = await createApp()
    const res = await app.request('/api/version-check/update', { method: 'POST' })
    expect(res.status).toBe(409)
  })

  it('starts the update and returns the run id for admin users', async () => {
    mockDbSelectGetResult = { role: 'admin' }
    const app = await createApp()
    const res = await app.request('/api/version-check/update', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.started).toBe(true)
    expect(body.runId).toBe('run-1234')
    expect(mockStartSelfUpdate).toHaveBeenCalledTimes(1)
  })
})

describe('GET /api/version-check/last-update', () => {
  beforeEach(resetMocks)

  it('returns null when no update was ever attempted', async () => {
    const app = await createApp()
    const res = await app.request('/api/version-check/last-update')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.run).toBeNull()
  })

  it('returns the last run when present', async () => {
    mockLastRun = {
      id: 'run-1234',
      channel: 'stable',
      fromVersion: '1.0.0',
      fromSha: 'abc1234',
      toVersion: '1.1.0',
      status: 'success',
      currentStep: null,
      error: null,
      startedAt: 1,
      finishedAt: 2,
    }
    const app = await createApp()
    const res = await app.request('/api/version-check/last-update')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.run.id).toBe('run-1234')
    expect(body.run.status).toBe('success')
  })
})
