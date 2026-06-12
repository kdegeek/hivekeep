// ─── Plugin System Types ─────────────────────────────────────────────────────

export interface PluginConfigField {
  type: 'string' | 'number' | 'boolean' | 'select' | 'text' | 'password'
  label: string
  description?: string
  required?: boolean
  default?: any
  secret?: boolean
  // type-specific
  options?: string[]       // select
  min?: number             // number
  max?: number             // number
  step?: number            // number
  placeholder?: string     // string, text
  pattern?: string         // string
  rows?: number            // text
}

/**
 * Field declaration for a channel adapter's configuration schema, as
 * surfaced in the plugin manifest (`channels.<platform>.configSchema.fields`).
 *
 * Mirrors `ChannelConfigField` from `src/server/channels/adapter.ts`. Kept
 * permissive here on purpose: the manifest is parsed before the channel
 * adapter is instantiated, so we tolerate unknown fields and rely on the
 * adapter contract for stricter checks downstream.
 */
export interface PluginChannelConfigField {
  name: string
  label: string
  type: 'text' | 'password' | 'number' | 'select' | 'switch'
  default?: unknown
  required?: boolean
  placeholder?: string
  description?: string
  options?: string[] | { value: string; label: string }[]
  min?: number
  max?: number
}

export interface PluginChannelConfigSchema {
  fields: PluginChannelConfigField[]
}

export interface PluginChannelManifestEntry {
  configSchema?: PluginChannelConfigSchema
  /** Forward-compatible: plugin manifests may grow other per-channel keys. */
  [key: string]: unknown
}

export interface PluginManifest {
  /**
   * Technical identifier — must match the npm package name (lowercase,
   * kebab-case, no spaces). Used for filesystem paths, the install/uninstall
   * URLs, and dependency declarations.
   */
  name: string
  /**
   * Human-readable name shown in the UI (e.g. "Mistral AI", "Notion
   * Sync"). Optional — falls back to `name` when omitted.
   */
  displayName?: string
  version: string
  description: string
  author?: string
  homepage?: string
  license?: string
  hivekeep?: string
  main: string
  /** Emoji shown when the plugin has no real logo (back-compat). */
  icon?: string
  /**
   * Path (relative to the plugin's root) to a logo file shipped inside
   * the package. Must be a `.png`, `.jpg`, `.svg`, or `.webp` declared
   * in the package.json `files` array so it ends up in the tarball.
   * Example: `"logo.svg"` or `"assets/logo.png"`.
   *
   * When set:
   * - Installed plugins serve it at `GET /api/plugins/:name/logo`
   * - npm marketplace surfaces it via `https://unpkg.com/<pkg>/<iconUrl>`
   */
  iconUrl?: string
  permissions?: string[]
  dependencies?: Record<string, string>  // plugin-name → semver range (e.g. ">=1.0.0")
  config?: Record<string, PluginConfigField>
  /**
   * Optional declarative metadata for the channel adapters this plugin
   * exposes. Currently used to declare a `configSchema` that the UI / server
   * pick up via the standard `ChannelAdapter.configSchema` getter. Accepted
   * permissively at manifest level — see `validateManifest` for details.
   */
  channels?: Record<string, PluginChannelManifestEntry>
}

export interface PluginProviderMeta {
  type: string
  displayName: string
  capabilities: string[]
}

export interface PluginChannelMeta {
  platform: string
  displayName: string
}

export type PluginInstallSource = 'local' | 'git' | 'npm'

export interface PluginInstallMeta {
  url?: string        // git URL
  package?: string    // npm package name
  version?: string    // installed version
  installedAt?: string // ISO date
  /** Browser-ready repository URL captured at install time. For npm,
   *  read from the package's package.json and normalized (drop git+
   *  prefix, .git suffix). For git installs, the install URL itself. */
  repository?: string
}

// ─── Registry Types ──────────────────────────────────────────────────────────

/**
 * Normalised npm search result. Built from registry.npmjs.org's
 * `/-/v1/search` API, which returns the `{ objects: [{ package, score }] }`
 * shape — Hivekeep's UI just needs the flat fields below.
 */
export interface NpmPlugin {
  /** Full npm package name (e.g. `@marlburrow/hivekeep-plugin-x`). */
  name: string
  /** Human-readable name from manifest.displayName (fetched via unpkg).
   *  Missing for packages that don't ship a plugin.json or where the
   *  manifest doesn't declare one — UI falls back to `name`. */
  displayName?: string
  /** Latest version published to npm. */
  version: string
  /** One-line description from package.json. */
  description: string
  /** Author name (free-form). */
  author: string
  /** Publisher's npm username (always present, used for trust display). */
  publisherUsername?: string
  /** Free-form keywords from package.json — used by the UI to surface tags. */
  keywords: string[]
  /** When the latest version was published. */
  date?: string
  /** npm-computed quality/popularity/maintenance composite. 0..1. */
  score?: number
  /** Links from package.json (homepage, repository, bugs, npm). */
  links?: {
    npm?: string
    homepage?: string
    repository?: string
    bugs?: string
  }
  /**
   * Absolute URL to the plugin's logo, served by unpkg.com from the
   * tarball. Set when the plugin's `plugin.json` declares `iconUrl` and
   * the file is shipped in the published package.
   */
  logoUrl?: string
}

export interface PluginHealthStats {
  totalErrors: number
  consecutiveErrors: number
  lastError?: string
  lastErrorAt?: string  // ISO date
  autoDisabled: boolean
  autoDisabledAt?: string  // ISO date
}

export interface PluginSummary {
  name: string
  /** Human-readable name from manifest.displayName, falling back to `name`. */
  displayName?: string
  version: string
  description: string
  author?: string
  homepage?: string
  license?: string
  icon?: string
  /** Set when the plugin ships a logo file (manifest.iconUrl); resolved
   *  to `/api/plugins/<name>/logo` so the UI can `<img src="…">` directly. */
  logoUrl?: string
  /** Browser-ready URL to the plugin's source repository. Derived from
   *  the install meta (git URL or the npm package's repository field);
   *  normalized to drop `git+` prefixes and `.git` suffixes. */
  repositoryUrl?: string
  /** Set when the plugin was installed from npm — points to the package
   *  page on npmjs.com. Derived from `installMeta.package`. */
  npmUrl?: string
  permissions: string[]
  enabled: boolean
  error?: string
  toolCount: number
  hookCount: number
  providerCount: number
  channelCount: number
  providers: PluginProviderMeta[]
  channels: PluginChannelMeta[]
  configSchema: Record<string, PluginConfigField>
  installSource?: PluginInstallSource
  installMeta?: PluginInstallMeta
  dependencies: Record<string, string>
  dependents: string[]  // plugins that depend on this one
  compatible?: boolean
  compatibilityError?: string
  health: PluginHealthStats
}
