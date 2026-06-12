/**
 * Mini-App Backend Runner
 *
 * Loads and manages _server.js backends for mini-apps, with a full lifecycle:
 *
 *   export default function (ctx) {        // optional — HTTP routes
 *     const app = new ctx.Hono()
 *     app.get('/hello', (c) => c.json({ message: 'Hello!' }))
 *     return app
 *   }
 *   export async function onStart(ctx) {}  // optional — called when the backend loads
 *   export async function onStop(ctx) {}   // optional — called before unload/reload
 *
 * Backends are loaded lazily on first request, or eagerly at server boot when the
 * app's `app.json` manifest declares `"background": true`. Each loaded backend is a
 * tracked instance: managed timers (ctx.timers) and the abort signal (ctx.signal)
 * are cleaned up deterministically when the instance stops, so an edited backend
 * never leaves zombie intervals behind.
 *
 * The per-app SSE emitter intentionally survives reloads: connected clients keep
 * receiving events from the new instance. It is only dropped when the app is deleted.
 */

import { Hono } from 'hono'
import { join, resolve } from 'path'
import { existsSync } from 'fs'
import { createLogger } from '@/server/logger'
import {
  getMiniAppRow,
  getAppDir,
  listBackendAppIds,
  readAppManifest,
  storageGet,
  storageSet,
  storageDelete,
  storageList,
  storageClear,
} from '@/server/services/mini-apps'
import { pushConsoleEntry } from '@/server/services/mini-app-console'

const log = createLogger('mini-app-backend')

const ON_STOP_TIMEOUT_MS = 5_000
const MAX_TIMERS_PER_APP = 100
const MIN_INTERVAL_MS = 1_000

// ─── Event Emitter for SSE ──────────────────────────────────────────────────

type SSESubscriber = (event: string, data: unknown) => void

class AppEventEmitter {
  private subscribers = new Set<SSESubscriber>()

  /** Emit an event to all connected SSE clients */
  emit(event: string, data?: unknown): void {
    for (const sub of this.subscribers) {
      try { sub(event, data) } catch { /* ignore dead subscribers */ }
    }
  }

  /** Internal: add a subscriber (used by SSE route) */
  _subscribe(fn: SSESubscriber): () => void {
    this.subscribers.add(fn)
    return () => { this.subscribers.delete(fn) }
  }

  /** Number of active subscribers */
  get subscriberCount(): number {
    return this.subscribers.size
  }
}

/** Per-app event emitters, created lazily. Stable across backend reloads. */
const appEmitters = new Map<string, AppEventEmitter>()

/** Get or create the event emitter for an app */
export function getAppEmitter(appId: string): AppEventEmitter {
  let emitter = appEmitters.get(appId)
  if (!emitter) {
    emitter = new AppEventEmitter()
    appEmitters.set(appId, emitter)
  }
  return emitter
}

// ─── Types ──────────────────────────────────────────────────────────────────

type TimerId = ReturnType<typeof setTimeout>

/** Context passed to the backend module's default export and lifecycle hooks */
export interface MiniAppBackendContext {
  /** App ID */
  appId: string
  /** Agent ID that maintains this app */
  agentId: string
  /** App name */
  appName: string
  /** App version this instance was loaded from */
  version: number
  /** True when the app declares `"background": true` in app.json */
  background: boolean
  /** Hono constructor for creating routes */
  Hono: typeof Hono
  /** Aborted when this backend instance is stopped (reload, edit, shutdown) */
  signal: AbortSignal
  /** Managed timers — automatically cleared when the instance stops */
  timers: {
    setTimeout: (fn: () => void, ms: number) => TimerId
    setInterval: (fn: () => void, ms: number) => TimerId
    clearTimeout: (id: TimerId) => void
    clearInterval: (id: TimerId) => void
  }
  /** Key-value storage scoped to this app */
  storage: {
    get: (key: string) => Promise<unknown | null>
    set: (key: string, value: unknown) => Promise<void>
    delete: (key: string) => Promise<boolean>
    list: () => Promise<{ key: string; size: number }[]>
    clear: () => Promise<number>
  }
  /** Push real-time events to connected frontend clients via SSE */
  events: {
    /** Emit a named event with optional data to all connected clients */
    emit: (event: string, data?: unknown) => void
    /** Number of currently connected SSE clients */
    readonly subscriberCount: number
  }
  /** Logger — entries also land in the app console (get_mini_app_console) */
  log: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
    debug: (...args: unknown[]) => void
  }
}

interface BackendModule {
  default?: (ctx: MiniAppBackendContext) => Hono
  onStart?: (ctx: MiniAppBackendContext) => void | Promise<void>
  onStop?: (ctx: MiniAppBackendContext) => void | Promise<void>
}

interface BackendInstance {
  handler: Hono | null
  version: number
  loadedAt: number
  background: boolean
  controller: AbortController
  timers: Set<TimerId>
  module: BackendModule
  ctx: MiniAppBackendContext
}

// ─── Instance registry ──────────────────────────────────────────────────────

const instances = new Map<string, BackendInstance>()
/** Dedupe concurrent loads of the same app */
const loading = new Map<string, Promise<BackendInstance | null>>()

/** Stop a backend instance: clear timers, abort signal, run onStop (bounded). */
async function stopInstance(appId: string, inst: BackendInstance): Promise<void> {
  for (const id of inst.timers) {
    clearTimeout(id)
    clearInterval(id)
  }
  inst.timers.clear()

  try { inst.controller.abort() } catch { /* listeners may throw */ }

  if (typeof inst.module.onStop === 'function') {
    try {
      await Promise.race([
        Promise.resolve(inst.module.onStop(inst.ctx)),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`onStop timed out after ${ON_STOP_TIMEOUT_MS}ms`)), ON_STOP_TIMEOUT_MS)),
      ])
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn({ appId, error: message }, 'Backend onStop failed')
      pushBackendConsole(appId, 'warn', [`onStop failed: ${message}`])
    }
  }

  log.info({ appId, version: inst.version }, 'Backend instance stopped')
}

/**
 * Clear a specific backend from cache (e.g. after _server.js update).
 * The previous instance is stopped asynchronously (timers are cleared synchronously
 * inside stopInstance before any await).
 */
export function invalidateBackend(appId: string): void {
  const inst = instances.get(appId)
  if (!inst) return
  instances.delete(appId)
  void stopInstance(appId, inst)
}

/** Stop the backend and drop the SSE emitter. Used when the app is deleted. */
export function removeBackend(appId: string): void {
  invalidateBackend(appId)
  appEmitters.delete(appId)
}

// ─── Console bridge ─────────────────────────────────────────────────────────

function pushBackendConsole(appId: string, level: 'log' | 'warn' | 'error', args: unknown[]): void {
  try {
    pushConsoleEntry(appId, {
      level,
      args: args.map((a) => {
        if (typeof a === 'string') return a
        try { return JSON.stringify(a) } catch { return String(a) }
      }),
      stack: null,
      timestamp: Date.now(),
      source: 'backend',
    })
  } catch { /* console buffer must never break the backend */ }
}

// ─── Build context ──────────────────────────────────────────────────────────

function buildContext(params: {
  appId: string
  agentId: string
  appName: string
  version: number
  background: boolean
  controller: AbortController
  timers: Set<TimerId>
}): MiniAppBackendContext {
  const { appId, agentId, appName, version, background, controller, timers } = params
  const appLog = createLogger(`mini-app:${appId.slice(0, 8)}`)
  const emitter = getAppEmitter(appId)

  return {
    appId,
    agentId,
    appName,
    version,
    background,
    Hono,
    signal: controller.signal,
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        if (timers.size >= MAX_TIMERS_PER_APP) throw new Error(`Too many active timers (max ${MAX_TIMERS_PER_APP})`)
        const id = setTimeout(() => {
          timers.delete(id)
          try { fn() } catch (err) {
            pushBackendConsole(appId, 'error', [`Timer callback failed: ${err instanceof Error ? err.message : String(err)}`])
          }
        }, ms)
        timers.add(id)
        return id
      },
      setInterval: (fn: () => void, ms: number) => {
        if (timers.size >= MAX_TIMERS_PER_APP) throw new Error(`Too many active timers (max ${MAX_TIMERS_PER_APP})`)
        if (ms < MIN_INTERVAL_MS) throw new Error(`Interval too short: minimum ${MIN_INTERVAL_MS}ms`)
        const id = setInterval(() => {
          try { fn() } catch (err) {
            pushBackendConsole(appId, 'error', [`Interval callback failed: ${err instanceof Error ? err.message : String(err)}`])
          }
        }, ms)
        timers.add(id)
        return id
      },
      clearTimeout: (id: TimerId) => { clearTimeout(id); timers.delete(id) },
      clearInterval: (id: TimerId) => { clearInterval(id); timers.delete(id) },
    },
    storage: {
      get: async (key: string) => {
        const raw = await storageGet(appId, key)
        if (raw === null) return null
        try { return JSON.parse(raw) } catch { return raw }
      },
      set: async (key: string, value: unknown) => {
        await storageSet(appId, key, JSON.stringify(value))
      },
      delete: (key: string) => storageDelete(appId, key),
      list: () => storageList(appId),
      clear: () => storageClear(appId),
    },
    events: {
      emit: (event: string, data?: unknown) => emitter.emit(event, data),
      get subscriberCount() { return emitter.subscriberCount },
    },
    log: {
      info: (...args: unknown[]) => {
        appLog.info({ appId }, String(args[0]), ...args.slice(1))
        pushBackendConsole(appId, 'log', args)
      },
      warn: (...args: unknown[]) => {
        appLog.warn({ appId }, String(args[0]), ...args.slice(1))
        pushBackendConsole(appId, 'warn', args)
      },
      error: (...args: unknown[]) => {
        appLog.error({ appId }, String(args[0]), ...args.slice(1))
        pushBackendConsole(appId, 'error', args)
      },
      debug: (...args: unknown[]) => appLog.debug({ appId }, String(args[0]), ...args.slice(1)),
    },
  }
}

// ─── Load backend ───────────────────────────────────────────────────────────

async function loadBackend(appId: string): Promise<BackendInstance | null> {
  const app = await getMiniAppRow(appId)
  if (!app || !app.hasBackend || !app.isActive) return null

  // Fast path: cached instance at the current version
  const cached = instances.get(appId)
  if (cached && cached.version === app.version) return cached

  // Dedupe concurrent (re)loads
  const pending = loading.get(appId)
  if (pending) return pending

  const promise = (async (): Promise<BackendInstance | null> => {
    // Stop the outdated instance BEFORE importing the new module, so the old
    // background work never overlaps the new instance.
    const outdated = instances.get(appId)
    if (outdated) {
      instances.delete(appId)
      await stopInstance(appId, outdated)
    }

    const dir = getAppDir(app.agentId, appId)
    const serverJsPath = resolve(join(dir, '_server.js'))
    const serverTsPath = resolve(join(dir, '_server.ts'))

    const serverPath = existsSync(serverJsPath) ? serverJsPath : existsSync(serverTsPath) ? serverTsPath : null
    if (!serverPath) {
      log.warn({ appId }, 'hasBackend=true but no _server.js found')
      return null
    }

    try {
      const manifest = await readAppManifest(appId)
      const background = manifest.background === true

      // Use a cache-busting query to force re-import on version change
      const moduleUrl = `${serverPath}?v=${app.version}&t=${Date.now()}`
      const mod = (await import(moduleUrl)) as BackendModule

      const factory = mod.default
      const hasLifecycle = typeof mod.onStart === 'function' || typeof mod.onStop === 'function'
      if (typeof factory !== 'function' && !hasLifecycle) {
        log.error({ appId }, '_server.js must export a default function (and/or onStart/onStop)')
        pushBackendConsole(appId, 'error', ['_server.js must export a default function returning a Hono app, and/or onStart/onStop lifecycle hooks'])
        return null
      }

      const controller = new AbortController()
      const timers = new Set<TimerId>()
      const ctx = buildContext({ appId, agentId: app.agentId, appName: app.name, version: app.version, background, controller, timers })

      let handler: Hono | null = null
      if (typeof factory === 'function') {
        const result = factory(ctx)
        if (!result || typeof (result as Hono).fetch !== 'function') {
          log.error({ appId }, '_server.js factory must return a Hono app (or object with .fetch)')
          pushBackendConsole(appId, 'error', ['_server.js default export must return a Hono app (or object with .fetch)'])
          return null
        }
        handler = result
      }

      const instance: BackendInstance = {
        handler,
        version: app.version,
        loadedAt: Date.now(),
        background,
        controller,
        timers,
        module: mod,
        ctx,
      }
      instances.set(appId, instance)

      if (typeof mod.onStart === 'function') {
        try {
          await mod.onStart(ctx)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.error({ appId, error: message }, 'Backend onStart failed')
          pushBackendConsole(appId, 'error', [`onStart failed: ${message}`])
          // Keep the instance: HTTP routes still work even if onStart failed.
        }
      }

      log.info({ appId, version: app.version, background, lifecycle: hasLifecycle }, 'Backend loaded')
      return instance
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error({ appId, error: message }, 'Failed to load backend')
      pushBackendConsole(appId, 'error', [`Failed to load _server.js: ${message}`])
      return null
    }
  })()

  loading.set(appId, promise)
  try {
    return await promise
  } finally {
    loading.delete(appId)
  }
}

// ─── File-change + boot hooks ───────────────────────────────────────────────

/**
 * React to a mini-app file change. Called by the file-write/delete service layer
 * (single choke point for both REST routes and Agent tools).
 * `_server.js`/`_server.ts`/`app.json` changes stop the running instance; background
 * apps are restarted immediately so their live part never silently stays down.
 */
export function handleAppFilesChanged(appId: string, relativePath: string): void {
  if (relativePath !== '_server.js' && relativePath !== '_server.ts' && relativePath !== 'app.json') return
  void restartBackend(appId)
}

/** Stop the current instance and reload it right away if the app runs in background. */
export async function restartBackend(appId: string): Promise<void> {
  invalidateBackend(appId)
  try {
    const app = await getMiniAppRow(appId)
    if (!app || !app.hasBackend || !app.isActive) return
    const manifest = await readAppManifest(appId)
    if (manifest.background === true) {
      await loadBackend(appId)
    }
  } catch (err) {
    log.error({ appId, error: err instanceof Error ? err.message : String(err) }, 'Backend restart failed')
  }
}

/**
 * Boot-time loader: eagerly start every active app whose manifest declares
 * `"background": true`. Lazy apps keep loading on first request.
 */
export async function initMiniAppBackends(): Promise<void> {
  try {
    const appIds = await listBackendAppIds()
    let started = 0
    for (const appId of appIds) {
      try {
        const manifest = await readAppManifest(appId)
        if (manifest.background !== true) continue
        const inst = await loadBackend(appId)
        if (inst) started++
      } catch (err) {
        log.error({ appId, error: err instanceof Error ? err.message : String(err) }, 'Failed to boot background backend')
      }
    }
    if (started > 0) log.info({ started }, 'Background mini-app backends started')
  } catch (err) {
    log.error({ error: err instanceof Error ? err.message : String(err) }, 'Failed to init mini-app backends')
  }
}

/** Graceful shutdown: stop all running instances (best-effort, bounded by onStop timeout). */
export async function stopAllBackends(): Promise<void> {
  const entries = [...instances.entries()]
  instances.clear()
  await Promise.allSettled(entries.map(([appId, inst]) => stopInstance(appId, inst)))
}

/** Introspection for tools/UI: status of a backend instance. */
export function getBackendStatus(appId: string): {
  loaded: boolean
  version: number | null
  background: boolean
  loadedAt: number | null
  activeTimers: number
  sseSubscribers: number
} {
  const inst = instances.get(appId)
  return {
    loaded: !!inst,
    version: inst?.version ?? null,
    background: inst?.background ?? false,
    loadedAt: inst?.loadedAt ?? null,
    activeTimers: inst?.timers.size ?? 0,
    sseSubscribers: appEmitters.get(appId)?.subscriberCount ?? 0,
  }
}

// ─── Handle request ─────────────────────────────────────────────────────────

/**
 * Handle an incoming API request for a mini-app backend.
 * Returns a Response or null if no backend is available.
 */
export async function handleBackendRequest(
  appId: string,
  request: Request,
  apiPath: string,
): Promise<Response | null> {
  const instance = await loadBackend(appId)
  if (!instance) return null
  if (!instance.handler) {
    return new Response(JSON.stringify({ error: { code: 'NO_HTTP_ROUTES', message: 'This backend only has lifecycle hooks. Export a default function returning a Hono app to add HTTP routes.' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    // Rewrite the URL so the handler sees paths relative to /
    const url = new URL(request.url)
    url.pathname = apiPath.startsWith('/') ? apiPath : `/${apiPath}`

    const rewrittenRequest = new Request(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      // @ts-ignore - duplex needed for streaming bodies in Bun
      duplex: 'half',
    })

    return await instance.handler.fetch(rewrittenRequest)
  } catch (err) {
    log.error({ appId, error: err instanceof Error ? err.message : String(err) }, 'Backend request error')
    return new Response(JSON.stringify({ error: { code: 'BACKEND_ERROR', message: 'Internal backend error' } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
