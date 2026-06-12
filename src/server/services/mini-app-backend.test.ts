import { describe, it, expect, beforeEach, mock } from 'bun:test'

// ─── AppEventEmitter (re-implemented for isolated testing) ──────────────────

type SSESubscriber = (event: string, data: unknown) => void

class AppEventEmitter {
  private subscribers = new Set<SSESubscriber>()

  emit(event: string, data?: unknown): void {
    for (const sub of this.subscribers) {
      try { sub(event, data) } catch { /* ignore dead subscribers */ }
    }
  }

  _subscribe(fn: SSESubscriber): () => void {
    this.subscribers.add(fn)
    return () => { this.subscribers.delete(fn) }
  }

  get subscriberCount(): number {
    return this.subscribers.size
  }
}

describe('AppEventEmitter', () => {
  let emitter: AppEventEmitter

  beforeEach(() => {
    emitter = new AppEventEmitter()
  })

  it('starts with zero subscribers', () => {
    expect(emitter.subscriberCount).toBe(0)
  })

  it('adds subscribers via _subscribe', () => {
    emitter._subscribe(() => {})
    emitter._subscribe(() => {})
    expect(emitter.subscriberCount).toBe(2)
  })

  it('removes subscriber when unsubscribe is called', () => {
    const unsub1 = emitter._subscribe(() => {})
    const unsub2 = emitter._subscribe(() => {})
    expect(emitter.subscriberCount).toBe(2)

    unsub1()
    expect(emitter.subscriberCount).toBe(1)

    unsub2()
    expect(emitter.subscriberCount).toBe(0)
  })

  it('delivers events to all subscribers', () => {
    const received1: Array<{ event: string; data: unknown }> = []
    const received2: Array<{ event: string; data: unknown }> = []

    emitter._subscribe((event, data) => received1.push({ event, data }))
    emitter._subscribe((event, data) => received2.push({ event, data }))

    emitter.emit('update', { count: 42 })

    expect(received1).toHaveLength(1)
    expect(received1[0]).toEqual({ event: 'update', data: { count: 42 } })
    expect(received2).toHaveLength(1)
    expect(received2[0]).toEqual({ event: 'update', data: { count: 42 } })
  })

  it('delivers events with undefined data when not provided', () => {
    const received: Array<{ event: string; data: unknown }> = []
    emitter._subscribe((event, data) => received.push({ event, data }))

    emitter.emit('ping')

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({ event: 'ping', data: undefined })
  })

  it('does not deliver events after unsubscribe', () => {
    const received: Array<{ event: string; data: unknown }> = []
    const unsub = emitter._subscribe((event, data) => received.push({ event, data }))

    emitter.emit('before', null)
    unsub()
    emitter.emit('after', null)

    expect(received).toHaveLength(1)
    expect(received[0]!.event).toBe('before')
  })

  it('continues delivering to other subscribers when one throws', () => {
    const received: string[] = []

    emitter._subscribe(() => { throw new Error('boom') })
    emitter._subscribe((event) => received.push(event))

    emitter.emit('test')

    expect(received).toEqual(['test'])
  })

  it('handles emit with no subscribers gracefully', () => {
    // Should not throw
    expect(() => emitter.emit('lonely-event', { data: true })).not.toThrow()
  })

  it('does not allow duplicate subscriptions of the same function', () => {
    const fn: SSESubscriber = () => {}
    emitter._subscribe(fn)
    emitter._subscribe(fn) // Set deduplicates
    expect(emitter.subscriberCount).toBe(1)
  })

  it('delivers multiple events in order', () => {
    const events: string[] = []
    emitter._subscribe((event) => events.push(event))

    emitter.emit('first')
    emitter.emit('second')
    emitter.emit('third')

    expect(events).toEqual(['first', 'second', 'third'])
  })

  it('handles various data types', () => {
    const received: unknown[] = []
    emitter._subscribe((_, data) => received.push(data))

    emitter.emit('string', 'hello')
    emitter.emit('number', 42)
    emitter.emit('array', [1, 2, 3])
    emitter.emit('null', null)
    emitter.emit('boolean', false)
    emitter.emit('nested', { a: { b: { c: 1 } } })

    expect(received).toEqual([
      'hello',
      42,
      [1, 2, 3],
      null,
      false,
      { a: { b: { c: 1 } } },
    ])
  })

  it('unsubscribe is idempotent', () => {
    const unsub = emitter._subscribe(() => {})
    expect(emitter.subscriberCount).toBe(1)

    unsub()
    expect(emitter.subscriberCount).toBe(0)

    // Calling again should not throw or go negative
    unsub()
    expect(emitter.subscriberCount).toBe(0)
  })
})

// ─── getAppEmitter / invalidateBackend pattern ─────────────────────────────

describe('App emitter registry', () => {
  it('returns same emitter for same appId', () => {
    const registry = new Map<string, AppEventEmitter>()

    function getEmitter(appId: string): AppEventEmitter {
      let emitter = registry.get(appId)
      if (!emitter) {
        emitter = new AppEventEmitter()
        registry.set(appId, emitter)
      }
      return emitter
    }

    const e1 = getEmitter('app-1')
    const e2 = getEmitter('app-1')
    expect(e1).toBe(e2)
  })

  it('returns different emitters for different appIds', () => {
    const registry = new Map<string, AppEventEmitter>()

    function getEmitter(appId: string): AppEventEmitter {
      let emitter = registry.get(appId)
      if (!emitter) {
        emitter = new AppEventEmitter()
        registry.set(appId, emitter)
      }
      return emitter
    }

    const e1 = getEmitter('app-1')
    const e2 = getEmitter('app-2')
    expect(e1).not.toBe(e2)
  })

  it('creates fresh emitter after cleanup', () => {
    const registry = new Map<string, AppEventEmitter>()

    function getEmitter(appId: string): AppEventEmitter {
      let emitter = registry.get(appId)
      if (!emitter) {
        emitter = new AppEventEmitter()
        registry.set(appId, emitter)
      }
      return emitter
    }

    function cleanup(appId: string): void {
      registry.delete(appId)
    }

    const e1 = getEmitter('app-1')
    e1._subscribe(() => {})
    expect(e1.subscriberCount).toBe(1)

    cleanup('app-1')

    const e2 = getEmitter('app-1')
    expect(e2).not.toBe(e1)
    expect(e2.subscriberCount).toBe(0)
  })

  it('cleanup is safe for non-existent appId', () => {
    const registry = new Map<string, AppEventEmitter>()
    // Should not throw
    expect(() => registry.delete('nonexistent')).not.toThrow()
  })
})

// ─── Backend cache pattern ──────────────────────────────────────────────────

interface CachedBackend {
  handler: unknown
  version: number
  loadedAt: number
}

describe('Backend cache', () => {
  let cache: Map<string, CachedBackend>

  beforeEach(() => {
    cache = new Map()
  })

  it('caches by appId', () => {
    cache.set('app-1', { handler: {}, version: 1, loadedAt: Date.now() })
    expect(cache.has('app-1')).toBe(true)
    expect(cache.get('app-1')!.version).toBe(1)
  })

  it('returns cached entry when version matches', () => {
    cache.set('app-1', { handler: { id: 'original' }, version: 3, loadedAt: Date.now() })

    const cached = cache.get('app-1')
    const appVersion = 3
    if (cached && cached.version === appVersion) {
      expect(cached.handler).toEqual({ id: 'original' })
    } else {
      // Should not reach here
      expect(true).toBe(false)
    }
  })

  it('invalidates when version changes', () => {
    cache.set('app-1', { handler: { id: 'old' }, version: 1, loadedAt: Date.now() })

    const cached = cache.get('app-1')
    const appVersion = 2
    const needsReload = !cached || cached.version !== appVersion
    expect(needsReload).toBe(true)
  })

  it('invalidateBackend removes entry', () => {
    cache.set('app-1', { handler: {}, version: 1, loadedAt: Date.now() })
    cache.set('app-2', { handler: {}, version: 1, loadedAt: Date.now() })

    cache.delete('app-1')

    expect(cache.has('app-1')).toBe(false)
    expect(cache.has('app-2')).toBe(true)
  })

})

// ─── Lifecycle: managed timers ──────────────────────────────────────────────

describe('Managed timers (ctx.timers contract)', () => {
  const MAX_TIMERS = 100
  const MIN_INTERVAL = 1000

  function makeTimers(timers: Set<ReturnType<typeof setTimeout>>) {
    return {
      setTimeout: (fn: () => void, ms: number) => {
        if (timers.size >= MAX_TIMERS) throw new Error(`Too many active timers (max ${MAX_TIMERS})`)
        const id = setTimeout(() => { timers.delete(id); fn() }, ms)
        timers.add(id)
        return id
      },
      setInterval: (fn: () => void, ms: number) => {
        if (timers.size >= MAX_TIMERS) throw new Error(`Too many active timers (max ${MAX_TIMERS})`)
        if (ms < MIN_INTERVAL) throw new Error(`Interval too short: minimum ${MIN_INTERVAL}ms`)
        const id = setInterval(fn, ms)
        timers.add(id)
        return id
      },
      clearTimeout: (id: ReturnType<typeof setTimeout>) => { clearTimeout(id); timers.delete(id) },
      clearInterval: (id: ReturnType<typeof setTimeout>) => { clearInterval(id); timers.delete(id) },
    }
  }

  function stopAll(timers: Set<ReturnType<typeof setTimeout>>) {
    for (const id of timers) { clearTimeout(id); clearInterval(id) }
    timers.clear()
  }

  it('tracks created timers and forgets fired timeouts', async () => {
    const tracked = new Set<ReturnType<typeof setTimeout>>()
    const t = makeTimers(tracked)

    let fired = false
    t.setTimeout(() => { fired = true }, 1)
    expect(tracked.size).toBe(1)

    await new Promise((r) => setTimeout(r, 15))
    expect(fired).toBe(true)
    expect(tracked.size).toBe(0)
  })

  it('stop clears pending timers so they never fire (no zombie work)', async () => {
    const tracked = new Set<ReturnType<typeof setTimeout>>()
    const t = makeTimers(tracked)

    let fired = false
    t.setTimeout(() => { fired = true }, 5)
    t.setInterval(() => { fired = true }, 1000)
    expect(tracked.size).toBe(2)

    stopAll(tracked)
    expect(tracked.size).toBe(0)

    await new Promise((r) => setTimeout(r, 20))
    expect(fired).toBe(false)
  })

  it('rejects intervals shorter than the minimum', () => {
    const tracked = new Set<ReturnType<typeof setTimeout>>()
    const t = makeTimers(tracked)
    expect(() => t.setInterval(() => {}, 50)).toThrow('Interval too short')
    expect(tracked.size).toBe(0)
  })

  it('caps the number of active timers', () => {
    const tracked = new Set<ReturnType<typeof setTimeout>>()
    const t = makeTimers(tracked)
    const created: Array<ReturnType<typeof setTimeout>> = []
    for (let i = 0; i < MAX_TIMERS; i++) created.push(t.setTimeout(() => {}, 60_000))
    expect(() => t.setTimeout(() => {}, 60_000)).toThrow('Too many active timers')
    for (const id of created) t.clearTimeout(id)
    expect(tracked.size).toBe(0)
  })

  it('clearTimeout/clearInterval remove from tracking', () => {
    const tracked = new Set<ReturnType<typeof setTimeout>>()
    const t = makeTimers(tracked)
    const a = t.setTimeout(() => {}, 60_000)
    const b = t.setInterval(() => {}, 60_000)
    expect(tracked.size).toBe(2)
    t.clearTimeout(a)
    t.clearInterval(b)
    expect(tracked.size).toBe(0)
  })
})

// ─── Lifecycle: onStop bounded execution ────────────────────────────────────

describe('onStop bounded execution', () => {
  async function runOnStop(onStop: () => Promise<void>, timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
    try {
      await Promise.race([
        Promise.resolve(onStop()),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`onStop timed out after ${timeoutMs}ms`)), timeoutMs)),
      ])
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  it('completes when onStop resolves in time', async () => {
    const result = await runOnStop(async () => {}, 100)
    expect(result.ok).toBe(true)
  })

  it('times out a hanging onStop instead of blocking the reload', async () => {
    const result = await runOnStop(() => new Promise(() => {}), 20)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('timed out')
  })

  it('captures onStop errors without throwing', async () => {
    const result = await runOnStop(async () => { throw new Error('cleanup failed') }, 100)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('cleanup failed')
  })
})

// ─── Lifecycle: abort signal ────────────────────────────────────────────────

describe('Instance abort signal (ctx.signal contract)', () => {
  it('signal aborts when the instance stops', () => {
    const controller = new AbortController()
    expect(controller.signal.aborted).toBe(false)
    controller.abort()
    expect(controller.signal.aborted).toBe(true)
  })

  it('abort listeners fire so backends can cancel in-flight work', () => {
    const controller = new AbortController()
    let cancelled = false
    controller.signal.addEventListener('abort', () => { cancelled = true })
    controller.abort()
    expect(cancelled).toBe(true)
  })
})

// ─── Emitter stability across reloads ───────────────────────────────────────

describe('Emitter survives backend reloads', () => {
  it('subscribers keep receiving events after instance swap when emitter is stable', () => {
    // Regression guard: emitters are NOT dropped on invalidation — connected
    // SSE clients must keep receiving events from the reloaded instance.
    const registry = new Map<string, AppEventEmitter>()
    function getEmitter(appId: string): AppEventEmitter {
      let emitter = registry.get(appId)
      if (!emitter) { emitter = new AppEventEmitter(); registry.set(appId, emitter) }
      return emitter
    }

    const received: string[] = []
    getEmitter('app-1')._subscribe((event) => received.push(event))

    // Old instance emits, then "reload" happens (cache invalidated, emitter kept)
    getEmitter('app-1').emit('before-reload')
    // New instance gets the same emitter
    const afterReload = getEmitter('app-1')
    afterReload.emit('after-reload')

    expect(received).toEqual(['before-reload', 'after-reload'])
  })
})

// ─── Manifest background flag parsing ───────────────────────────────────────

describe('app.json background flag', () => {
  function parseManifest(raw: string | null): Record<string, unknown> {
    if (!raw) return {}
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch { return {} }
  }

  it('detects background: true', () => {
    const m = parseManifest('{"background": true, "dependencies": {}}')
    expect(m.background === true).toBe(true)
  })

  it('treats missing/false/truthy-but-not-true as non-background', () => {
    expect(parseManifest('{}').background === true).toBe(false)
    expect(parseManifest('{"background": false}').background === true).toBe(false)
    expect(parseManifest('{"background": "yes"}').background === true).toBe(false)
    expect(parseManifest(null).background === true).toBe(false)
  })

  it('malformed manifest falls back to non-background', () => {
    expect(parseManifest('{not json').background === true).toBe(false)
  })
})

// ─── MiniAppBackendContext storage contract ─────────────────────────────────

describe('Storage context JSON serialization', () => {
  // The backend context wraps raw string storage with JSON.parse/JSON.stringify.
  // Test that contract.

  it('round-trips objects through JSON', () => {
    const original = { name: 'test', items: [1, 2, 3], nested: { deep: true } }
    const serialized = JSON.stringify(original)
    const deserialized = JSON.parse(serialized)
    expect(deserialized).toEqual(original)
  })

  it('round-trips arrays through JSON', () => {
    const original = [1, 'two', { three: 3 }]
    const serialized = JSON.stringify(original)
    const deserialized = JSON.parse(serialized)
    expect(deserialized).toEqual(original)
  })

  it('round-trips primitives through JSON', () => {
    expect(JSON.parse(JSON.stringify(42))).toBe(42)
    expect(JSON.parse(JSON.stringify('hello'))).toBe('hello')
    expect(JSON.parse(JSON.stringify(true))).toBe(true)
    expect(JSON.parse(JSON.stringify(null))).toBeNull()
  })

  it('get falls back to raw string when JSON.parse fails', () => {
    const raw = 'not-valid-json'
    let result: unknown
    try {
      result = JSON.parse(raw)
    } catch {
      result = raw
    }
    expect(result).toBe('not-valid-json')
  })

  it('handles empty object', () => {
    const serialized = JSON.stringify({})
    expect(JSON.parse(serialized)).toEqual({})
  })

  it('handles special characters in strings', () => {
    const original = { text: 'Hello "world" \n\ttab' }
    const serialized = JSON.stringify(original)
    expect(JSON.parse(serialized)).toEqual(original)
  })
})

// ─── Error response format ──────────────────────────────────────────────────

describe('Backend error response format', () => {
  it('produces valid JSON error response', () => {
    const body = JSON.stringify({
      error: { code: 'BACKEND_ERROR', message: 'Internal backend error' },
    })
    const parsed = JSON.parse(body)
    expect(parsed.error.code).toBe('BACKEND_ERROR')
    expect(parsed.error.message).toBe('Internal backend error')
  })

  it('error response has status 500', () => {
    const response = new Response(
      JSON.stringify({ error: { code: 'BACKEND_ERROR', message: 'Test' } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
    expect(response.status).toBe(500)
    expect(response.headers.get('Content-Type')).toBe('application/json')
  })
})

// ─── URL rewriting logic ────────────────────────────────────────────────────

describe('API path rewriting', () => {
  it('prepends / to paths without leading slash', () => {
    const apiPath = 'hello/world'
    const result = apiPath.startsWith('/') ? apiPath : `/${apiPath}`
    expect(result).toBe('/hello/world')
  })

  it('keeps / prefix for paths with leading slash', () => {
    const apiPath = '/hello/world'
    const result = apiPath.startsWith('/') ? apiPath : `/${apiPath}`
    expect(result).toBe('/hello/world')
  })

  it('rewrites URL pathname correctly', () => {
    const url = new URL('http://localhost:3000/api/mini-apps/abc/backend/hello')
    url.pathname = '/hello'
    expect(url.pathname).toBe('/hello')
    expect(url.toString()).toBe('http://localhost:3000/hello')
  })

  it('preserves query parameters during rewrite', () => {
    const url = new URL('http://localhost:3000/api/mini-apps/abc/backend/hello?foo=bar&baz=1')
    url.pathname = '/hello'
    expect(url.searchParams.get('foo')).toBe('bar')
    expect(url.searchParams.get('baz')).toBe('1')
  })

  it('handles root path', () => {
    const apiPath = '/'
    const result = apiPath.startsWith('/') ? apiPath : `/${apiPath}`
    expect(result).toBe('/')
  })

  it('handles empty path', () => {
    const apiPath = ''
    const result = apiPath.startsWith('/') ? apiPath : `/${apiPath}`
    expect(result).toBe('/')
  })
})
