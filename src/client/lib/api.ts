import { toast } from 'sonner'

const API_PATH_PREFIX = '/api'
export const MOBILE_SERVER_URL_STORAGE_KEY = 'hivekeep:serverUrl'
export const MOBILE_AUTH_TOKEN_STORAGE_KEY = 'auth_token'

export type NativeRuntime = 'desktop' | 'mobile'
export type AppSurface = 'desktop' | 'mobile'

declare global {
  interface Window {
    __HIVEKEEP_DESKTOP__?: boolean
    __HIVEKEEP_NATIVE_RUNTIME__?: NativeRuntime
    __HIVEKEEP_SURFACE__?: AppSurface
  }
}

function getInjectedNativeRuntime(): NativeRuntime | null {
  if (typeof window === 'undefined') return null
  const runtime = window.__HIVEKEEP_NATIVE_RUNTIME__
  return runtime === 'desktop' || runtime === 'mobile' ? runtime : null
}

function getRequestedSurface(): AppSurface | null {
  if (typeof window === 'undefined') return null
  const searchSurface = new URLSearchParams(window.location.search).get('surface')
  const injectedSurface = window.__HIVEKEEP_SURFACE__
  if (searchSurface === 'mobile' || injectedSurface === 'mobile') return 'mobile'
  if (searchSurface === 'desktop' || injectedSurface === 'desktop') return 'desktop'
  return null
}

export function isCapacitorRuntime(): boolean {
  return typeof window !== 'undefined' && window.location.protocol === 'capacitor:'
}

export function isDesktopRuntime(): boolean {
  return import.meta.env?.VITE_HIVEKEEP_DESKTOP === 'true' ||
    (typeof window !== 'undefined' && window.__HIVEKEEP_DESKTOP__ === true) ||
    getInjectedNativeRuntime() === 'desktop'
}

export function isMobileApiRuntime(): boolean {
  return import.meta.env?.VITE_HIVEKEEP_MOBILE === 'true' ||
    isCapacitorRuntime() ||
    getInjectedNativeRuntime() === 'mobile'
}

export function isNativeApiRuntime(): boolean {
  return isMobileApiRuntime() || isDesktopRuntime()
}

export function shouldUseMobileSurface(): boolean {
  const requestedSurface = getRequestedSurface()
  if (requestedSurface === 'mobile') return true
  if (requestedSurface === 'desktop') return false
  return isMobileApiRuntime() && !isDesktopRuntime()
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
  let trimmed = serverUrl.trim()
  if (!trimmed) throw new Error('Hivekeep server URL is required')
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `http://${trimmed}`
  }
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Hivekeep server URL must start with http:// or https://')
    }
    if (url.username || url.password) {
      throw new Error('Hivekeep server URL must not include credentials')
    }
    url.hash = ''
    url.search = ''
    const pathname = url.pathname
      .replace(/\/+$/, '')
      .replace(/\/api$/i, '')
    url.pathname = pathname || '/'
    return url.toString().replace(/\/+$/, '')
  } catch (err) {
    if (err instanceof Error && (
      err.message.includes('credentials') ||
      err.message.includes('http:// or https://')
    )) {
      throw err
    }
    throw new Error('Invalid URL format. Please enter a valid server address.')
  }
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

export function getNativeSessionToken(): string | null {
  if (typeof localStorage === 'undefined') return null
  try {
    return localStorage.getItem(MOBILE_AUTH_TOKEN_STORAGE_KEY)
  } catch {
    return null
  }
}

export function setNativeSessionToken(token: string): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(MOBILE_AUTH_TOKEN_STORAGE_KEY, token)
}

export function clearNativeSessionToken(): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(MOBILE_AUTH_TOKEN_STORAGE_KEY)
}

function toHeaderRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    const canonicalKey = key.toLowerCase() === 'content-type'
      ? 'Content-Type'
      : key.toLowerCase() === 'authorization'
        ? 'Authorization'
        : key
    record[canonicalKey] = value
  })
  return record
}

export function withNativeAuthTransport(options: RequestInit = {}): RequestInit {
  const headers = new Headers(options.headers)
  const token = isNativeApiRuntime() ? getNativeSessionToken() : null
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  return {
    ...options,
    credentials: isNativeApiRuntime() ? 'omit' : 'include',
    headers: toHeaderRecord(headers),
  }
}

export async function validateHivekeepServerConnection(serverUrl: string): Promise<string> {
  const normalized = normalizeHivekeepServerUrl(serverUrl)
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(`${normalized}${API_PATH_PREFIX}/health`, {
      credentials: isNativeApiRuntime() ? 'omit' : 'include',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`Hivekeep server responded with ${response.status}`)
    }
    const body = (await response.json()) as { status?: unknown }
    if (body.status !== 'ok') {
      throw new Error('Hivekeep server health check did not return ok')
    }
    return normalized
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Hivekeep server did not respond in time')
    }
    throw err
  } finally {
    window.clearTimeout(timeoutId)
  }
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

/**
 * Resolve a server-relative asset path (e.g. an agent avatar URL stored as
 * `/api/...`) to a fully-qualified URL for the current runtime. On the mobile
 * (Capacitor) runtime this prefixes the configured Hivekeep server root, the
 * same way {@link buildApiUrl} does for API calls; on the web it returns the
 * path unchanged so the browser resolves it against the document origin.
 */
export function resolveApiAssetUrl(path: string): string {
  if (!path) return path
  // Absolute URLs (http(s)://, data:, blob:, capacitor://) are returned as-is.
  if (/^(https?:|data:|blob:|capacitor:)/i.test(path)) return path
  if (!isMobileApiRuntime()) return path
  return buildApiUrl(path)
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
  const headers = new Headers(options?.headers)
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

  const response = await fetch(buildApiUrl(path), withNativeAuthTransport({
    ...options,
    headers,
  }))

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
