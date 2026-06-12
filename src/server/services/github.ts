/**
 * GitHub API wrapper for the per-project clone + worktree pipeline.
 *
 * - PATs live in the vault, keyed by `projects.github_pat_vault_key`.
 *   `resolvePat()` is the only entry point that touches the vault.
 * - All API calls go through `ghFetch()`, which normalises errors into
 *   `GitHubError` with a code the API layer can forward verbatim.
 * - The PAT is sent via `Authorization: Bearer ...` and is never logged
 *   or echoed in error messages.
 *
 * Scope: read-only discovery used by the repo picker and the clone
 * orchestrator. Write operations (creating PRs, commenting on issues)
 * go through the existing GitHub MCP server, not this module.
 */

import { createLogger } from '@/server/logger'
import { getSecretValue } from '@/server/services/vault'
import { GITHUB_REPO_REGEX } from '@/shared/constants'
import type { GitHubRepoSummary } from '@/shared/types'

export type { GitHubRepoSummary }

const log = createLogger('github')

const GITHUB_API = 'https://api.github.com'
const USER_AGENT = 'hivekeep'
const ACCEPT_HEADER = 'application/vnd.github+json'
const API_VERSION = '2022-11-28'

export class GitHubError extends Error {
  constructor(public code: string, message: string, public status?: number) {
    super(message)
    this.name = 'GitHubError'
  }
}

/** Resolve a PAT from the vault. Returns null when the key is unset or no
 *  matching entry exists. The decrypted value is never logged. */
export async function resolvePat(vaultKey: string | null | undefined): Promise<string | null> {
  if (!vaultKey) return null
  return await getSecretValue(vaultKey)
}

interface GHRepoRaw {
  full_name: string
  name: string
  owner: { login: string }
  private: boolean
  default_branch: string
  description: string | null
  html_url: string
  permissions?: { push?: boolean }
}

interface GHSearchRaw {
  items: GHRepoRaw[]
}

function mapRepo(raw: GHRepoRaw, includePermissions: boolean): GitHubRepoSummary {
  return {
    fullName: raw.full_name,
    name: raw.name,
    owner: raw.owner.login,
    private: raw.private,
    defaultBranch: raw.default_branch,
    description: raw.description,
    htmlUrl: raw.html_url,
    canPush: includePermissions ? (raw.permissions?.push ?? null) : null,
  }
}

async function ghFetch<T>(path: string, pat: string, init?: RequestInit): Promise<T> {
  const url = path.startsWith('http') ? path : `${GITHUB_API}${path}`
  let res: Response
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Accept: ACCEPT_HEADER,
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': API_VERSION,
        Authorization: `Bearer ${pat}`,
        ...(init?.headers ?? {}),
      },
    })
  } catch (err) {
    // Network-level failure (DNS, offline, TLS). Don't leak the PAT.
    const message = err instanceof Error ? err.message : 'unknown network error'
    log.warn({ path }, `GitHub fetch failed: ${message}`)
    throw new GitHubError('GITHUB_NETWORK_ERROR', `Network error talking to GitHub: ${message}`)
  }

  if (res.status === 401) {
    throw new GitHubError('GITHUB_UNAUTHENTICATED', 'GitHub rejected the token (401)', 401)
  }
  if (res.status === 403) {
    const body = await res.text().catch(() => '')
    const rateLimited = body.includes('rate limit') || res.headers.get('x-ratelimit-remaining') === '0'
    throw new GitHubError(
      rateLimited ? 'GITHUB_RATE_LIMITED' : 'GITHUB_FORBIDDEN',
      rateLimited ? 'GitHub API rate limit exceeded' : 'GitHub API request forbidden',
      403,
    )
  }
  if (res.status === 404) {
    throw new GitHubError('GITHUB_NOT_FOUND', 'GitHub resource not found (404)', 404)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new GitHubError(
      'GITHUB_API_ERROR',
      `GitHub API ${res.status}: ${body.slice(0, 200)}`,
      res.status,
    )
  }
  return (await res.json()) as T
}

export interface ListAccessibleReposOpts {
  /** 1-100, default 50. Caps are GitHub's. */
  perPage?: number
  /** 1-based page index, default 1. */
  page?: number
}

/**
 * Repos the PAT can read across all affiliations the user has access to:
 * owned, collaborator, and organisation member. Sorted by most-recently
 * updated to mirror the GitHub UI default.
 */
export async function listAccessibleRepos(
  pat: string,
  opts: ListAccessibleReposOpts = {},
): Promise<GitHubRepoSummary[]> {
  const perPage = Math.min(Math.max(opts.perPage ?? 50, 1), 100)
  const page = Math.max(opts.page ?? 1, 1)
  const params = new URLSearchParams({
    affiliation: 'owner,collaborator,organization_member',
    sort: 'updated',
    per_page: String(perPage),
    page: String(page),
  })
  const raw = await ghFetch<GHRepoRaw[]>(`/user/repos?${params.toString()}`, pat)
  return raw.map((r) => mapRepo(r, true))
}

export interface SearchReposOpts {
  perPage?: number
  page?: number
}

/**
 * Free-form repo search across all of GitHub (public + repos the PAT can
 * see). Empty queries return `[]` without hitting the API — the picker
 * uses `listAccessibleRepos` for the empty-search case.
 */
export async function searchRepos(
  pat: string,
  query: string,
  opts: SearchReposOpts = {},
): Promise<GitHubRepoSummary[]> {
  const trimmed = query.trim()
  if (!trimmed) return []
  const perPage = Math.min(Math.max(opts.perPage ?? 30, 1), 100)
  const page = Math.max(opts.page ?? 1, 1)
  const params = new URLSearchParams({
    q: trimmed,
    per_page: String(perPage),
    page: String(page),
  })
  const data = await ghFetch<GHSearchRaw>(`/search/repositories?${params.toString()}`, pat)
  return data.items.map((r) => mapRepo(r, false))
}

/** Throws `GitHubError('INVALID_GITHUB_REPO')` on bad shape. */
export function assertValidRepoName(fullName: string): void {
  if (!GITHUB_REPO_REGEX.test(fullName)) {
    throw new GitHubError(
      'INVALID_GITHUB_REPO',
      `Invalid repo "${fullName}", expected "owner/name"`,
      400,
    )
  }
}

/**
 * Fetch a single repo. Used at "save project" time to confirm the PAT can
 * see the chosen repo and to learn its default branch before kicking off
 * the clone.
 */
export async function getRepo(pat: string, fullName: string): Promise<GitHubRepoSummary> {
  assertValidRepoName(fullName)
  const raw = await ghFetch<GHRepoRaw>(`/repos/${fullName}`, pat)
  return mapRepo(raw, true)
}
