import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'

// ─── Mocks ───────────────────────────────────────────────────────────────────
//
// We exercise the route handler in isolation. The card service and the
// plugin manager are stubbed, so this test covers the request/response
// contract: parameter parsing, 404 on missing cards, 503 when the plugin
// is unloaded, 400 when the plugin does not implement onCardAction, and
// the happy path that returns whatever the handler returns.

const mockGetPluginCardWithOwner = mock<(id: string) => Promise<{ card: any; agentId: string; messageId: string } | null>>(
  () => Promise.resolve(null),
)
const mockGetPlugin = mock<(name: string) => any>(() => undefined)

mock.module('@/server/services/plugin-cards', () => ({
  getPluginCardWithOwner: mockGetPluginCardWithOwner,
  emitPluginCard: mock(() => Promise.resolve({ messageId: 'm', cardInstanceId: 'c' })),
  updatePluginCard: mock(() => Promise.resolve()),
  getPluginCard: mock(() => Promise.resolve(null)),
}))

// Preserve the real module's other exports (e.g. createPluginVault) so that
// other test files importing from '@/server/services/plugins' are not poisoned
// by this partial mock when bun runs the whole suite in one process.
const realPlugins = await import('@/server/services/plugins')
mock.module('@/server/services/plugins', () => ({
  ...realPlugins,
  pluginManager: { getPlugin: mockGetPlugin },
}))

mock.module('@/server/logger', () => ({
  createLogger: () => ({
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  }),
}))

// Imported after mocks are installed so the route picks up the stubs.
const { pluginCardRoutes } = await import('@/server/routes/plugin-cards')

function makeApp() {
  const app = new Hono()
  app.route('/api/plugin-cards', pluginCardRoutes)
  return app
}

function postAction(app: Hono, cardId: string, body: unknown) {
  return app.request(`/api/plugin-cards/${cardId}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('POST /api/plugin-cards/:cardInstanceId/action', () => {
  beforeEach(() => {
    mockGetPluginCardWithOwner.mockReset()
    mockGetPlugin.mockReset()
  })

  test('returns 400 when actionId is missing', async () => {
    const app = makeApp()
    const res = await postAction(app, 'card-1', {})
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error?.code).toBe('BAD_REQUEST')
  })

  test('returns 400 when body is not valid JSON', async () => {
    const app = makeApp()
    const res = await postAction(app, 'card-1', '{not json')
    expect(res.status).toBe(400)
  })

  test('returns 404 when the card cannot be located', async () => {
    mockGetPluginCardWithOwner.mockImplementationOnce(() => Promise.resolve(null))
    const app = makeApp()
    const res = await postAction(app, 'missing-card', { actionId: 'abort' })
    expect(res.status).toBe(404)
    const body = await res.json() as any
    expect(body.error?.code).toBe('CARD_NOT_FOUND')
  })

  test('returns 503 when the owning plugin is not loaded', async () => {
    mockGetPluginCardWithOwner.mockImplementationOnce(() => Promise.resolve({
      card: { pluginId: 'claude-code', cardType: 'task-run', cardInstanceId: 'c', layout: [], state: {} } as any,
      agentId: 'agent-1',
      messageId: 'msg-1',
    }))
    mockGetPlugin.mockImplementationOnce(() => undefined)
    const app = makeApp()
    const res = await postAction(app, 'c', { actionId: 'abort' })
    expect(res.status).toBe(503)
  })

  test('returns 400 when the plugin has no onCardAction handler', async () => {
    mockGetPluginCardWithOwner.mockImplementationOnce(() => Promise.resolve({
      card: { pluginId: 'demo', cardType: 't', cardInstanceId: 'c', layout: [], state: {} } as any,
      agentId: 'agent-1',
      messageId: 'msg-1',
    }))
    mockGetPlugin.mockImplementationOnce(() => ({
      enabled: true,
      exports: { /* no onCardAction */ },
    }))
    const app = makeApp()
    const res = await postAction(app, 'c', { actionId: 'noop' })
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error?.code).toBe('ACTION_UNSUPPORTED')
  })

  test('dispatches to the plugin and forwards a successful result', async () => {
    const handler = mock<(...args: any[]) => Promise<any>>(() => Promise.resolve({ ok: true }))
    mockGetPluginCardWithOwner.mockImplementationOnce(() => Promise.resolve({
      card: { pluginId: 'demo', cardType: 't', cardInstanceId: 'c', layout: [], state: {} } as any,
      agentId: 'agent-42',
      messageId: 'msg-1',
    }))
    mockGetPlugin.mockImplementationOnce(() => ({
      enabled: true,
      exports: { onCardAction: handler },
    }))
    const app = makeApp()
    const res = await postAction(app, 'c', { actionId: 'send-message', input: 'hello' })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]![0]).toEqual({
      cardInstanceId: 'c',
      actionId: 'send-message',
      input: 'hello',
      agentId: 'agent-42',
    })
  })

  test('forwards a plugin-reported failure as 400 with the plugin error', async () => {
    mockGetPluginCardWithOwner.mockImplementationOnce(() => Promise.resolve({
      card: { pluginId: 'demo', cardType: 't', cardInstanceId: 'c', layout: [], state: {} } as any,
      agentId: 'agent-1',
      messageId: 'msg-1',
    }))
    mockGetPlugin.mockImplementationOnce(() => ({
      enabled: true,
      exports: { onCardAction: () => Promise.resolve({ ok: false, error: 'session already aborted' }) },
    }))
    const app = makeApp()
    const res = await postAction(app, 'c', { actionId: 'abort' })
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error?.code).toBe('ACTION_FAILED')
    expect(body.error?.message).toBe('session already aborted')
  })

  test('returns 500 with a useful message when the plugin handler throws', async () => {
    mockGetPluginCardWithOwner.mockImplementationOnce(() => Promise.resolve({
      card: { pluginId: 'demo', cardType: 't', cardInstanceId: 'c', layout: [], state: {} } as any,
      agentId: 'agent-1',
      messageId: 'msg-1',
    }))
    mockGetPlugin.mockImplementationOnce(() => ({
      enabled: true,
      exports: { onCardAction: () => Promise.reject(new Error('boom')) },
    }))
    const app = makeApp()
    const res = await postAction(app, 'c', { actionId: 'abort' })
    expect(res.status).toBe(500)
    const body = await res.json() as any
    expect(body.error?.code).toBe('ACTION_CRASHED')
    expect(body.error?.message).toBe('boom')
  })
})
