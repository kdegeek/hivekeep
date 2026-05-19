import { createLogger } from '@/server/logger'
import type { NpmPlugin } from '@/shared/types/plugin'

const log = createLogger('plugin-registry')

/**
 * The keyword every KinBot plugin published to npm should declare in
 * its `package.json`. The scaffolder generates it by default; the
 * Browse tab searches against it to surface only relevant packages.
 */
const NPM_KINBOT_PLUGIN_KEYWORD = 'kinbot-plugin'

/** Short cache to avoid hammering registry.npmjs.org on every keystroke. */
const NPM_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000

interface NpmSearchCacheEntry {
  data: NpmPlugin[]
  fetchedAt: number
}

/** Raw shape returned by registry.npmjs.org's `/-/v1/search` endpoint. */
interface NpmSearchResponse {
  objects?: Array<{
    package?: {
      name?: string
      version?: string
      description?: string
      keywords?: string[]
      date?: string
      author?: { name?: string }
      publisher?: { username?: string }
      links?: {
        npm?: string
        homepage?: string
        repository?: string
        bugs?: string
      }
    }
    score?: { final?: number }
  }>
  total?: number
}

export class PluginRegistryService {
  private npmSearchCache = new Map<string, NpmSearchCacheEntry>()

  /**
   * Search npm for packages tagged with the `kinbot-plugin` keyword.
   * Goes through the public registry search API
   * (`registry.npmjs.org/-/v1/search`). Combines the keyword filter
   * with the user's free-form query so authors can search by name /
   * description / their own tags.
   *
   * Cached for 5 minutes per query so a Browse-tab keystroke storm
   * doesn't hammer npm. Empty query returns the latest 20 plugins
   * matching the keyword (default discovery).
   */
  async searchNpm(query?: string): Promise<NpmPlugin[]> {
    const cacheKey = (query ?? '').trim().toLowerCase()
    const cached = this.npmSearchCache.get(cacheKey)
    if (cached && Date.now() - cached.fetchedAt < NPM_SEARCH_CACHE_TTL_MS) {
      return cached.data
    }

    // The npm search API treats `text` as a space-separated set of
    // qualifiers. `keywords:<kw>` filters; the rest is fuzzy search.
    const textParts = [`keywords:${NPM_KINBOT_PLUGIN_KEYWORD}`]
    if (cacheKey) textParts.push(cacheKey)
    const url =
      `https://registry.npmjs.org/-/v1/search?` +
      `text=${encodeURIComponent(textParts.join(' '))}&size=20`

    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) {
        log.warn({ status: res.status, query }, 'npm search request failed')
        return []
      }
      const raw = (await res.json()) as NpmSearchResponse
      const data: NpmPlugin[] = (raw.objects ?? [])
        .map((o) => {
          const p = o.package
          if (!p?.name || !p.version) return null
          return {
            name: p.name,
            version: p.version,
            description: p.description ?? '',
            author: p.author?.name ?? p.publisher?.username ?? '',
            ...(p.publisher?.username ? { publisherUsername: p.publisher.username } : {}),
            keywords: p.keywords ?? [],
            ...(p.date ? { date: p.date } : {}),
            ...(o.score?.final != null ? { score: o.score.final } : {}),
            ...(p.links ? { links: p.links } : {}),
          } satisfies NpmPlugin
        })
        .filter((x): x is NpmPlugin => x !== null)

      this.npmSearchCache.set(cacheKey, { data, fetchedAt: Date.now() })
      return data
    } catch (err) {
      log.warn({ err, query }, 'npm search threw')
      return []
    }
  }

  /** Test-only: flush the npm search cache so tests don't bleed state. */
  resetNpmSearchCache(): void {
    this.npmSearchCache.clear()
  }
}

export const pluginRegistry = new PluginRegistryService()
