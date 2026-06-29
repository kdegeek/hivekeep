import { readFileSync } from 'node:fs'
import { expect, test, type Page, type Route } from 'playwright/test'

const API_ORIGIN = 'http://127.0.0.1:38888'
const now = new Date('2026-06-28T12:00:00.000Z').toISOString()

const user = {
  id: 'user-1',
  email: 'mobile@example.com',
  firstName: 'Mobile',
  lastName: 'Tester',
  pseudonym: 'MT',
  language: 'en',
  agentLanguage: null,
  role: 'admin',
  avatarUrl: null,
  agentOrder: null,
  onboardingModalDismissed: true,
  theme: null,
  palette: null,
  contrastMode: null,
  createdAt: Date.now(),
  serverTimezone: 'America/Chicago',
  cronOrder: null,
}

const agent = {
  id: 'agent-1',
  slug: 'smokey',
  name: 'Smokey',
  role: 'Mobile smoke agent',
  kind: 'regular',
  avatarUrl: null,
  model: 'gpt-smoke',
  providerId: 'provider-1',
  activeProjectId: null,
  createdAt: now,
  thinkingEnabled: false,
  thinkingEffort: null,
  isProcessing: false,
  queueSize: 0,
}

const model = {
  id: 'gpt-smoke',
  name: 'Smoke Model',
  providerId: 'provider-1',
  providerName: 'Smoke Provider',
  providerType: 'openai',
  capability: 'llm',
  contextWindow: 8192,
  maxOutput: 1024,
}

const providerType = {
  type: 'openai',
  displayName: 'OpenAI',
  capabilities: ['llm'],
  noApiKey: false,
  optionalApiKey: false,
  source: 'builtin',
}

const activeTask = {
  id: 'task-1',
  status: 'in_progress',
  title: 'Mobile active task',
  description: 'Mobile active task',
  sourceAgentName: 'Smokey',
  sourceAgentAvatarUrl: null,
  parentAgentName: 'Smokey',
  parentAgentAvatarUrl: null,
  createdAt: now,
  startedAt: now,
  endedAt: null,
  model: 'gpt-smoke',
  providerType: 'openai',
  thinkingEnabled: false,
  thinkingEffort: null,
  cronId: null,
  depth: 0,
  concurrencyGroup: null,
  tokenUsage: null,
}

const notification = {
  id: 'notification-1',
  type: 'agent:alert',
  title: 'Mobile notification smoke',
  body: 'A smoke-test notification body.',
  isRead: false,
  agentId: agent.id,
  agentName: agent.name,
  agentSlug: agent.slug,
  relatedType: 'agent',
  relatedId: agent.id,
  createdAt: now,
}

test.describe('mobile smoke', () => {
  test('exposes local Android APK build scripts', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    expect(packageJson.scripts['mobile:android:apk:debug']).toBe('node scripts/package-android-apk.mjs debug')
    expect(packageJson.scripts['mobile:android:apk:release']).toBe('node scripts/package-android-apk.mjs release')
    const apkScript = readFileSync('scripts/package-android-apk.mjs', 'utf8')
    expect(apkScript).toContain('assembleDebug')
    expect(apkScript).toContain('assembleRelease')
  })

  test('uses configured API URL and shows login guard at mobile width', async ({ page }) => {
    const requests = await installApiMock(page, { authenticated: false })

    await page.goto('/')

    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
    await expect(page.locator('input[type="email"]')).toBeVisible()
    expect(requests.some((url) => url.href.startsWith(`${API_ORIGIN}/api/onboarding/status`))).toBe(true)
    expect(requests.some((url) => url.href.startsWith(`${API_ORIGIN}/api/me`))).toBe(true)
  })

  test('renders agent list, chat send, tasks, and notifications', async ({ page }) => {
    const requests = await installApiMock(page, { authenticated: true })

    await page.goto('/')

    await expect(page.getByRole('heading', { name: 'Your Agents' })).toBeVisible()
    await expect(page.getByText('Smokey')).toBeVisible()

    await page.getByRole('button', { name: /Open chat with Smokey|Open chat/ }).first().click()
    await expect(page.getByText('Mobile smoke agent')).toBeVisible()

    const composer = page.locator('textarea').last()
    await composer.fill('Hello from mobile smoke')
    await composer.press('Enter')
    await expect(page.getByText('Hello from mobile smoke').first()).toBeVisible()
    expect(requests.some((url) => url.pathname === '/api/agents/agent-1/messages' && url.search === '')).toBe(true)

    await page.goto('/tasks')
    await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible()
    await expect(page.getByText('Mobile active task')).toBeVisible()

    await page.goto('/notifications')
    await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible()
    await expect(page.getByText('Mobile notification smoke')).toBeVisible()

    expect(requests.some((url) => url.pathname === '/api/notifications')).toBe(true)
  })
})

async function installApiMock(page: Page, options: { authenticated: boolean }): Promise<URL[]> {
  const requests: URL[] = []
  page.on('pageerror', (error) => console.log('PAGEERROR', error.stack ?? error.message))
  page.on('console', (msg) => { if (msg.type() === 'error') console.log('BROWSERCONSOLE', msg.text()) })

  await page.addInitScript((serverUrl) => {
    window.localStorage.setItem('hivekeep:serverUrl', serverUrl)
  }, API_ORIGIN)

  await page.route(`${API_ORIGIN}/api/**`, async (route) => {
    const url = new URL(route.request().url())
    requests.push(url)
    await fulfillApi(route, url, options)
  })

  return requests
}

async function fulfillApi(route: Route, url: URL, options: { authenticated: boolean }) {
  const request = route.request()
  const method = request.method()

  if (method === 'OPTIONS') {
    await route.fulfill({ status: 204, headers: corsHeaders() })
    return
  }

  const path = url.pathname.replace(/^\/api/, '') || '/'

  if (path === '/sse') {
    await route.fulfill({
      status: 200,
      headers: {
        ...corsHeaders(),
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
      body: 'event: connected\ndata: {}\n\n',
    })
    return
  }

  if (path === '/health') return json(route, { status: 'ok' })
  if (path === '/onboarding/status') return json(route, { completed: true, hasAdmin: true, hasLlm: true, hasEmbedding: true })

  if (path === '/me') {
    if (!options.authenticated) return json(route, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401)
    return json(route, user)
  }

  if (!options.authenticated) {
    return json(route, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401)
  }

  if (path === '/providers/types') return json(route, { types: [providerType] })
  if (path === '/providers/models') return json(route, { models: [model] })
  if (path === '/providers') return json(route, { providers: [] })
  if (path === '/agents') return json(route, { agents: [agent] })
  if (path === '/agents/agent-1') return json(route, { ...agent, character: '', expertise: '', scoutModel: null, scoutProviderId: null, workspacePath: '', toolboxIds: null, extraToolNames: null, compactingConfig: null, thinkingConfig: null, mcpServers: [], isCompacting: false })
  if (path === '/agents/agent-1/context-usage') return json(route, { contextTokens: 0, contextWindow: 8192 })
  if (path === '/agents/agent-1/messages') {
    if (method === 'POST') return json(route, {})
    return json(route, { messages: [], hasMore: false, streamingMessage: null })
  }
  if (path === '/agents/agent-1/messages/queue') return json(route, { items: [] })
  if (path === '/agents/agent-1/tools') return json(route, { tools: [] })
  if (path === '/agents/agent-1/mark-read') return json(route, {})

  if (path === '/projects') return json(route, { projects: [] })
  if (path === '/crons') return json(route, { crons: [] })
  if (path === '/me/unread-counts') return json(route, { counts: {} })
  if (path === '/users/mentionables') return json(route, { users: [], agents: [] })
  if (path === '/prompts/pending') return json(route, { prompts: [] })
  if (path === '/secret-prompts/pending') return json(route, { prompts: [] })
  if (path === '/tool-calls') return json(route, { toolCalls: [], total: 0 })
  if (path === '/version-check') return json(route, { currentVersion: '1.9.0', currentSha: null, latestVersion: '1.9.0', isUpdateAvailable: false, channel: 'stable', checkedAt: Date.now(), changelog: [], installationType: 'manual', canSelfUpdate: false, selfUpdateBlockedReason: 'dev-mode', releaseUrl: null })
  if (path === '/version-check/last-update') return json(route, { run: null })
  if (path === '/settings/default-models') return json(route, { llmModel: null, llmProviderId: null, embeddingModel: null, embeddingProviderId: null })
  if (path === '/settings/dismissed-setup-items') return json(route, { items: [] })

  if (path === '/tasks') {
    const status = url.searchParams.get('status')
    const tasks = status === 'in_progress' || (!status && url.searchParams.get('limit') === '20') ? [activeTask] : []
    return json(route, { tasks, total: tasks.length, hasMore: false })
  }

  if (path === '/notifications') {
    return json(route, {
      notifications: [notification],
      unreadCount: 1,
      total: 1,
      hasMore: false,
    })
  }

  if (method === 'POST' || method === 'PATCH' || method === 'DELETE') return json(route, {})
  return json(route, emptyPayloadFor(path))
}

function emptyPayloadFor(path: string): unknown {
  if (path.includes('quick-sessions')) return { sessions: [], hasMore: false }
  if (path.includes('workspace-files/search')) return { hits: [] }
  if (path.includes('tickets/search')) return { hits: [] }
  if (path.includes('notifications')) return { notifications: [], unreadCount: 0, total: 0, hasMore: false }
  if (path.includes('tasks')) return { tasks: [], total: 0, hasMore: false }
  return {}
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    headers: {
      ...corsHeaders(),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

function corsHeaders() {
  return {
    'access-control-allow-origin': 'http://127.0.0.1:4173',
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'content-type, accept',
    'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
  }
}
