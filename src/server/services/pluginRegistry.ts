import { createLogger } from '@/server/logger'
import type { NpmPlugin } from '@/shared/types/plugin'

const log = createLogger('plugin-registry')

/**
 * The keyword every Hivekeep plugin published to npm should declare in
 * its `package.json`. The scaffolder generates it by default; the
 * Browse tab searches against it to surface only relevant packages.
 */
const NPM_HIVEKEEP_PLUGIN_KEYWORD = 'hivekeep-plugin'

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
   * Search npm for packages tagged with the `hivekeep-plugin` keyword.
   * Goes through the public registry search API
   * (`registry.npmjs.org/-/v1/search`). Combines the keyword filter
   * with the user's free-form query so authors can search by name /
   * description / their own tags.
   *
   * Cached for 5 minutes per query so a Browse-tab keystroke storm
   * doesn't hammer npm. Empty query returns the latest 20 plugins
   * matching the keyword (default discovery).
   */
  async searchNpm(query?: string, opts?: { force?: boolean }): Promise<NpmPlugin[]> {
    const cacheKey = (query ?? '').trim().toLowerCase()
    if (!opts?.force) {
      const cached = this.npmSearchCache.get(cacheKey)
      if (cached && Date.now() - cached.fetchedAt < NPM_SEARCH_CACHE_TTL_MS) {
        return cached.data
      }
    }

    // The npm search API treats `text` as a space-separated set of
    // qualifiers. `keywords:<kw>` filters; the rest is fuzzy search.
    const textParts = [`keywords:${NPM_HIVEKEEP_PLUGIN_KEYWORD}`]
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
      const baseData: NpmPlugin[] = (raw.objects ?? [])
        .map((o) => {
          const p = o.package
          if (!p?.name || !p.version) return null
          // npm reports `repository` in its raw package.json form, often
          // prefixed with `git+` (npm convention). Browsers don't follow
          // unknown URL schemes — strip it so anchors actually navigate.
          const normalizedLinks = p.links ? normalizeLinks(p.links) : undefined
          return {
            name: p.name,
            version: p.version,
            description: p.description ?? '',
            author: p.author?.name ?? p.publisher?.username ?? '',
            ...(p.publisher?.username ? { publisherUsername: p.publisher.username } : {}),
            keywords: p.keywords ?? [],
            ...(p.date ? { date: p.date } : {}),
            ...(o.score?.final != null ? { score: o.score.final } : {}),
            ...(normalizedLinks ? { links: normalizedLinks } : {}),
          } satisfies NpmPlugin
        })
        .filter((x): x is NpmPlugin => x !== null)

      // Enrich each result with its logoUrl (best-effort, parallel,
      // timeouts). Fetches plugin.json from unpkg and points logoUrl at
      // the absolute file path in the tarball. Failures are silent —
      // the card simply doesn't show a logo.
      const data = await Promise.all(baseData.map((p) => this.enrichWithLogo(p)))

      this.npmSearchCache.set(cacheKey, { data, fetchedAt: Date.now() })
      return data
    } catch (err) {
      log.warn({ err, query }, 'npm search threw')
      return []
    }
  }

  /**
   * Best-effort manifest fetch for an npm search result. Pulls plugin.json
   * from unpkg in a single round-trip, then enriches the search-result
   * shape with anything the npm index doesn't already expose:
   *   - logoUrl (resolved from manifest.iconUrl)
   *   - displayName (so the card shows "Mistral AI" not "hivekeep-plugin-mistral")
   *
   * Returns the input plugin unchanged on any failure (timeout, 404,
   * malformed manifest). 3s timeout — search latency matters more than
   * 100% enrichment coverage on first paint.
   */
  private async enrichWithLogo(plugin: NpmPlugin): Promise<NpmPlugin> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)
      const manifestUrl = `https://unpkg.com/${plugin.name}@${plugin.version}/plugin.json`
      const res = await fetch(manifestUrl, { signal: controller.signal })
      clearTimeout(timer)
      if (!res.ok) return plugin
      const manifest = (await res.json()) as { iconUrl?: string; displayName?: string }
      const enriched: NpmPlugin = { ...plugin }
      if (manifest.displayName && typeof manifest.displayName === 'string') {
        enriched.displayName = manifest.displayName
      }
      if (manifest.iconUrl && typeof manifest.iconUrl === 'string' && !manifest.iconUrl.includes('..')) {
        const normalized = manifest.iconUrl.replace(/^\/+/, '')
        enriched.logoUrl = `https://unpkg.com/${plugin.name}@${plugin.version}/${normalized}`
      }
      return enriched
    } catch {
      return plugin
    }
  }

  /** Test-only: flush the npm search cache so tests don't bleed state. */
  resetNpmSearchCache(): void {
    this.npmSearchCache.clear()
  }
}

/**
 * Convert an npm-style `repository` URL into something a browser can open.
 * npm package.json conventions accept `git+https://`, `git://`,
 * `git@github.com:owner/repo.git`, etc. — none of which are valid for
 * an `<a href>`. We only normalise the repository field; others
 * (homepage, npm, bugs) are already plain http(s) URLs in practice.
 */
function normalizeLinks(links: NonNullable<NpmPlugin['links']>): NpmPlugin['links'] {
  const out: NonNullable<NpmPlugin['links']> = { ...links }
  if (out.repository) {
    let r = out.repository
    // `git+https://...` → `https://...`
    if (r.startsWith('git+')) r = r.slice(4)
    // `git://github.com/...` → `https://github.com/...`
    if (r.startsWith('git://')) r = 'https://' + r.slice(6)
    // SSH form `git@host:owner/repo.git` → `https://host/owner/repo`
    const sshMatch = r.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
    if (sshMatch) r = `https://${sshMatch[1]}/${sshMatch[2]}`
    // Trailing `.git` is fine for `git clone` but ugly in a browser
    if (r.endsWith('.git')) r = r.slice(0, -4)
    out.repository = r
  }
  return out
}

export const pluginRegistry = new PluginRegistryService()
