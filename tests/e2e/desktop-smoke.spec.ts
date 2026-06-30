import { readFileSync } from 'node:fs'
import { expect, test, type Page, type Route } from 'playwright/test'

const API_ORIGIN = 'http://127.0.0.1:38889'
const DESKTOP_ORIGIN = 'http://127.0.0.1:4174'
const AUTH_TOKEN = 'desktop-smoke-bearer-token'
const now = new Date('2026-06-28T12:00:00.000Z').toISOString()

const user = {
  id: 'user-1',
  email: 'desktop@example.com',
  firstName: 'Desktop',
  lastName: 'Tester',
  pseudonym: 'DT',
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
  role: 'Desktop smoke agent',
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
  title: 'Desktop active task',
  description: 'Desktop active task',
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
  title: 'Desktop notification smoke',
  body: 'A desktop smoke-test notification body.',
  isRead: false,
  agentId: agent.id,
  agentName: agent.name,
  agentSlug: agent.slug,
  relatedType: 'agent',
  relatedId: agent.id,
  createdAt: now,
}

test.describe('desktop smoke', () => {
  test('exposes desktop scripts, Tauri config, and manual smoke docs', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    expect(packageJson.scripts['desktop:dev']).toBe('tauri dev')
    expect(packageJson.scripts['desktop:build']).toBe('node --max-old-space-size=8192 ./node_modules/vite/bin/vite.js build --mode desktop')
    expect(packageJson.scripts['desktop:bundle:win']).toBe('tauri build --bundles msi,nsis')

    const desktopEnv = readFileSync('.env.desktop', 'utf8')
    expect(desktopEnv).toContain('VITE_HIVEKEEP_DESKTOP=true')
    expect(desktopEnv).toContain('VITE_HIVEKEEP_MOBILE=true')

    const tauriConfig = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as {
      build: Record<string, string>
      app: { windows: Array<Record<string, unknown>> }
      bundle: { targets: string[]; windows: { nsis: Record<string, unknown> } }
    }
    expect(tauriConfig.build.beforeDevCommand).toBe('npm run dev:client -- --mode desktop')
    expect(tauriConfig.build.beforeBuildCommand).toBe('npm run desktop:build')
    expect(tauriConfig.build.frontendDist).toBe('../dist/client')
    expect(tauriConfig.app.windows[0]).toMatchObject({
      label: 'main',
      title: 'Hivekeep',
      minWidth: 960,
      minHeight: 640,
      resizable: true,
    })
    expect(tauriConfig.bundle.targets).toEqual(expect.arrayContaining(['msi', 'nsis']))
    expect(tauriConfig.bundle.windows.nsis).toMatchObject({
      installMode: 'currentUser',
      startMenuFolder: 'Hivekeep',
    })

    const mainRs = readFileSync('src-tauri/src/main.rs', 'utf8')
    expect(mainRs).toContain('WebviewUrl::App("index.html?surface=mobile&quickPanel=1".into())')
    expect(mainRs).toContain('.text(OPEN_MAIN_MENU_ID, "Open Hivekeep")')
    expect(mainRs).toContain('.text(QUICK_PANEL_MENU_ID, "Quick Panel")')
    expect(mainRs).toContain('.text(SETTINGS_MENU_ID, "Settings / Server URL")')
    expect(mainRs).toContain('WindowEvent::CloseRequested')
    expect(mainRs).toContain('api.prevent_close()')

    const desktopDocs = readFileSync('docs/windows-desktop.md', 'utf8')
    expect(desktopDocs).toContain('## Manual smoke checklist')
    expect(desktopDocs).toContain('### Tray/window behaviors that need manual verification')
  })

  test('boots the desktop runtime with a saved server URL and desktop shell', async ({ page }) => {
    const runtimeErrors = collectRuntimeErrors(page)
    const requests = await installApiMock(page, { authenticated: true })

    await page.goto('/')

    await expect(page.getByRole('navigation', { name: 'Application sections' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Hivekeep' })).toBeVisible()
    await expect(page.getByText('Smokey')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Your Agents' })).toHaveCount(0)

    expect(requests.some((url) => url.pathname === '/api/me')).toBe(true)
    expect(requests.some((url) => url.pathname === '/api/agents')).toBe(true)
    expect(requests.every((url) => url.origin === API_ORIGIN || url.origin === DESKTOP_ORIGIN)).toBe(true)
    expect(runtimeErrors).toEqual([])
  })

  test('renders the quick-panel mobile surface under the desktop runtime', async ({ page }) => {
    const runtimeErrors = collectRuntimeErrors(page)
    const requests = await installApiMock(page, { authenticated: true })

    await page.setViewportSize({ width: 390, height: 620 })
    await page.goto('/?surface=mobile&quickPanel=1')

    await expect(page.getByRole('heading', { name: 'Your Agents' })).toBeVisible()
    await expect(page.getByText('Smokey')).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Application sections' })).toHaveCount(0)

    expect(requests.some((url) => url.pathname === '/api/me')).toBe(true)
    expect(requests.some((url) => url.pathname === '/api/agents')).toBe(true)
    expect(requests.every((url) => url.origin === API_ORIGIN || url.origin === DESKTOP_ORIGIN)).toBe(true)
    expect(runtimeErrors).toEqual([])
  })
})

function collectRuntimeErrors(page: Page): string[] {
  const runtimeErrors: string[] = []
  page.on('pageerror', (error) => runtimeErrors.push(error.stack ?? error.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') runtimeErrors.push(msg.text())
  })
  return runtimeErrors
}

async function installApiMock(page: Page, options: { authenticated: boolean }): Promise<URL[]> {
  const requests: URL[] = []

  await page.addInitScript(({ serverUrl, authToken }) => {
    window.localStorage.setItem('hivekeep:serverUrl', serverUrl)
    window.localStorage.setItem('hivekeep:mobileAuthToken', authToken)
  }, { serverUrl: API_ORIGIN, authToken: AUTH_TOKEN })

  await page.route(`${API_ORIGIN}/api/**`, async (route) => {
    const url = new URL(route.request().url())
    requests.push(url)
    await fulfillApi(route, url, options)
  })

  await page.route(`${DESKTOP_ORIGIN}/api/**`, async (route) => {
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

  // The desktop/native runtime authenticates with a bearer token via
  // withNativeAuthTransport (no cookies). Enforce it on authenticated routes so
  // this test fails if the native transport stops sending the Authorization
  // header. /health and /onboarding/status are public and skip the check.
  if (options.authenticated && path !== '/health' && path !== '/onboarding/status') {
    const authHeader = await request.headerValue('authorization')
    if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
      return json(route, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401)
    }
  }

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
  if (path === '/agents/agent-1/messages') return json(route, { messages: [], hasMore: false, streamingMessage: null })
  if (path === '/agents/agent-1/messages/queue') return json(route, { items: [] })
  if (path === '/agents/agent-1/tools') return json(route, { tools: [] })
  if (path === '/agents/agent-1/mark-read') return json(route, {})

  if (path === '/projects') return json(route, { projects: [] })
  if (path === '/crons') return json(route, { crons: [] })
  if (path === '/channels') return json(route, { channels: [] })
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
    'access-control-allow-origin': DESKTOP_ORIGIN,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'content-type, accept, authorization',
    'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
  }
}
