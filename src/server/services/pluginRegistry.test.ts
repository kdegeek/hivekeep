import { describe, test, expect, beforeEach } from 'bun:test'

import { PluginRegistryService } from '@/server/services/pluginRegistry'

// Create a fresh instance to avoid mock.module pollution from other test files
const registry = new PluginRegistryService()

describe('PluginRegistryService', () => {
  describe('searchNpm', () => {
    let originalFetch: typeof globalThis.fetch
    beforeEach(() => {
      originalFetch = globalThis.fetch
      registry.resetNpmSearchCache()
    })
    const restore = () => {
      ;(globalThis as any).fetch = originalFetch
    }

    test('queries the npm search API with the hivekeep-plugin keyword filter', async () => {
      let capturedUrl = ''
      ;(globalThis as any).fetch = async (url: string) => {
        capturedUrl = url
        return new Response(JSON.stringify({ objects: [] }), { status: 200 })
      }
      try {
        await registry.searchNpm('weather')
      } finally {
        restore()
      }
      expect(capturedUrl).toContain('registry.npmjs.org')
      expect(decodeURIComponent(capturedUrl)).toContain('keywords:hivekeep-plugin')
      expect(decodeURIComponent(capturedUrl)).toContain('weather')
    })

    test('normalises the npm response into a flat NpmPlugin[] shape', async () => {
      ;(globalThis as any).fetch = async () =>
        new Response(JSON.stringify({
          objects: [
            {
              package: {
                name: '@marlburrow/hivekeep-plugin-weather',
                version: '1.2.3',
                description: 'Weather lookups',
                keywords: ['hivekeep-plugin', 'weather'],
                date: '2026-05-01T00:00:00Z',
                author: { name: 'MarlBurroW' },
                publisher: { username: 'marlburrow' },
                links: {
                  npm: 'https://www.npmjs.com/package/@marlburrow/hivekeep-plugin-weather',
                  homepage: 'https://github.com/marlburrow/hivekeep-plugin-weather',
                  repository: 'https://github.com/marlburrow/hivekeep-plugin-weather',
                },
              },
              score: { final: 0.42 },
            },
          ],
        }), { status: 200 })
      try {
        const results = await registry.searchNpm('weather')
        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({
          name: '@marlburrow/hivekeep-plugin-weather',
          version: '1.2.3',
          description: 'Weather lookups',
          author: 'MarlBurroW',
          publisherUsername: 'marlburrow',
          keywords: ['hivekeep-plugin', 'weather'],
          score: 0.42,
        })
      } finally {
        restore()
      }
    })

    test('caches results per query within the TTL window', async () => {
      let calls = 0
      ;(globalThis as any).fetch = async () => {
        calls++
        return new Response(JSON.stringify({ objects: [] }), { status: 200 })
      }
      try {
        await registry.searchNpm('foo')
        await registry.searchNpm('foo')
        await registry.searchNpm('foo')
        expect(calls).toBe(1)
        // Different query → second fetch.
        await registry.searchNpm('bar')
        expect(calls).toBe(2)
      } finally {
        restore()
      }
    })

    test('returns empty array on npm error (not thrown — UI degrades gracefully)', async () => {
      ;(globalThis as any).fetch = async () =>
        new Response('upstream broken', { status: 503 })
      try {
        const results = await registry.searchNpm('foo')
        expect(results).toEqual([])
      } finally {
        restore()
      }
    })

    test('drops entries missing required fields (name/version)', async () => {
      ;(globalThis as any).fetch = async () =>
        new Response(JSON.stringify({
          objects: [
            { package: { name: 'has-name-no-version' } },
            { package: { version: '1.0.0' } },
            { package: { name: 'ok', version: '1.0.0', description: 'fine' } },
          ],
        }), { status: 200 })
      try {
        const results = await registry.searchNpm('')
        expect(results.map((p) => p.name)).toEqual(['ok'])
      } finally {
        restore()
      }
    })
  })
})
