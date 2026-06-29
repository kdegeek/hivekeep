import { toast } from 'sonner'

const API_PATH_PREFIX = '/api'
export const MOBILE_SERVER_URL_STORAGE_KEY = 'hivekeep:serverUrl'

export function isCapacitorRuntime(): boolean {
  return typeof window !== 'undefined' && window.location.protocol === 'capacitor:'
}

export function isMobileApiRuntime(): boolean {
  return import.meta.env?.VITE_HIVEKEEP_MOBILE === 'true' || isCapacitorRuntime()
}

function getStoredServerUrl(): string | null {
  if (typeof localStorage === 'undefined') return null
  try {
    return localStorage.getItem(MOBILE_SERVER_URL_STORAGE_KEY)
  } catch {
    return null
  }
}

export function normalizeHivekeepServerUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim()
  if (!trimmed) throw new Error('Hivekeep server URL is required')
  const url = new URL(trimmed)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Hivekeep server URL must start with http:// or https://')
  }
  if (url.username || url.password) {
    throw new Error('Hivekeep server URL must not include credentials')
  }
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/+$/, '')
}

export function getHivekeepServerUrl(): string | null {
  const stored = getStoredServerUrl()
  if (!stored) return null
  return normalizeHivekeepServerUrl(stored)
}

export function setHivekeepServerUrl(serverUrl: string): string {
  if (typeof localStorage === 'undefined') throw new Error('Server URL storage is unavailable')
  const normalized = normalizeHivekeepServerUrl(serverUrl)
  localStorage.setItem(MOBILE_SERVER_URL_STORAGE_KEY, normalized)
  return normalized
}

export function clearHivekeepServerUrl(): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(MOBILE_SERVER_URL_STORAGE_KEY)
}

export function buildApiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const serverUrl = isMobileApiRuntime() ? getHivekeepServerUrl() : null
  if (!serverUrl && isCapacitorRuntime()) {
    throw new Error('Hivekeep server URL is not configured')
  }
  return serverUrl
    ? `${serverUrl}${API_PATH_PREFIX}${normalizedPath}`
    : `${API_PATH_PREFIX}${normalizedPath}`
}

// ─── Custom error class ───────────────────────────────────────────────────────

export class ApiRequestError extends Error {
  readonly code: string
  readonly status: number

  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = 'ApiRequestError'
    this.code = code
    this.status = status
  }
}

// ─── Universal error message extractor ──────────────────────────────────────

/**
 * Extract a displayable string from any caught value.
 * Always use this in catch blocks instead of `String(err)`.
 *
 * Recognized shapes:
 *  - `Error` instances → `.message`
 *  - Hivekeep API shape `{ error: { code, message } }` → inner message
 *  - Better Auth shape `{ code, message }` (flat) → `.message`. Routes
 *    under `/api/auth/*` are served directly by Better Auth and don't
 *    follow Hivekeep's wrapped error format.
 */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err !== null && typeof err === 'object') {
    const o = err as { error?: unknown; message?: unknown }
    if (typeof o.error === 'object' && o.error !== null) {
      const inner = o.error as { message?: unknown }
      if (typeof inner.message === 'string' && inner.message) return inner.message
    }
    if (typeof o.message === 'string' && o.message) return o.message
  }
  return 'An unexpected error occurred'
}

/**
 * Shorthand for `toast.error(getErrorMessage(err))`.
 * Use in catch blocks to show a toast with the extracted error message.
 */
export function toastError(err: unknown): void {
  toast.error(getErrorMessage(err))
}

// ─── Core fetch wrapper ───────────────────────────────────────────────────────

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(buildApiUrl(path), {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })

  if (!response.ok) {
    let code = 'REQUEST_FAILED'
    let message = `Request failed with status ${response.status}`
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } }
      if (body?.error?.message) message = body.error.message
      if (body?.error?.code) code = body.error.code
    } catch {
      // Non-JSON body (HTML 502, 504, Nginx error pages) — keep defaults
    }
    throw new ApiRequestError(message, code, response.status)
  }

  // Guard against empty bodies (204 No Content, DELETE with no body, etc.)
  const contentType = response.headers.get('content-type')
  if (!contentType?.includes('application/json') || response.status === 204) {
    return undefined as T
  }

  return response.json() as Promise<T>
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}
