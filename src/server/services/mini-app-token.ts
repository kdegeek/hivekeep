/**
 * Mini-app iframe tokens.
 *
 * The hardened iframe runs at an OPAQUE origin (sandbox without
 * `allow-same-origin`), so the user's session cookie never reaches its JS — it
 * therefore cannot call `/api/*` with the user's identity at all. To let the app
 * reach its OWN namespace (`/api/mini-apps/<id>/*`), the `/serve` route (loaded
 * with a session cookie in web or a one-time frame token in native) mints a
 * short-lived token bound to (appId, userId) and injects it into the document.
 * The SDK sends it as the `x-hivekeep-app-token` header (or `?_t=` for the
 * EventSource, which can't set headers). authMiddleware accepts it ONLY for
 * that app's namespace.
 *
 * In-memory + TTL: tokens are ephemeral (a fresh one is minted on every iframe
 * load), so losing them on restart just means open iframes re-mint on reload.
 */

import { randomBytes } from 'crypto'

interface AppTokenEntry {
  appId: string
  userId: string
  expiresAt: number
}

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000 // 12h — re-minted on every iframe load
const FRAME_TOKEN_TTL_MS = 60 * 1000 // one-minute bootstrap token for iframe navigation
const tokens = new Map<string, AppTokenEntry>()
const frameTokens = new Map<string, AppTokenEntry>()

/** Mint a token for (appId, userId). Returns the opaque token string. */
export function mintAppToken(appId: string, userId: string): string {
  const token = randomBytes(32).toString('base64url')
  tokens.set(token, { appId, userId, expiresAt: Date.now() + TOKEN_TTL_MS })
  // Opportunistic cleanup so the map can't grow unbounded across reloads.
  if (tokens.size > 5000) {
    const now = Date.now()
    for (const [t, e] of tokens) if (e.expiresAt < now) tokens.delete(t)
  }
  return token
}

/** Resolve a token to its (appId, userId), or null if unknown/expired. */
export function resolveAppToken(token: string): { appId: string; userId: string } | null {
  const entry = tokens.get(token)
  if (!entry) return null
  if (entry.expiresAt < Date.now()) {
    tokens.delete(token)
    return null
  }
  return { appId: entry.appId, userId: entry.userId }
}

/**
 * Mint a one-time token that authorizes a native bearer-authenticated parent
 * window to navigate an iframe to /api/mini-apps/:id/serve. Browsers cannot add
 * Authorization headers to iframe navigations, so the parent obtains this over
 * an authenticated XHR and appends it to the frame URL.
 */
export function mintFrameToken(appId: string, userId: string): string {
  const token = randomBytes(32).toString('base64url')
  frameTokens.set(token, { appId, userId, expiresAt: Date.now() + FRAME_TOKEN_TTL_MS })
  if (frameTokens.size > 5000) {
    const now = Date.now()
    for (const [t, e] of frameTokens) if (e.expiresAt < now) frameTokens.delete(t)
  }
  return token
}

/** Resolve and consume a one-time iframe navigation token. */
export function resolveFrameToken(token: string): { appId: string; userId: string } | null {
  const entry = frameTokens.get(token)
  if (!entry) return null
  frameTokens.delete(token)
  if (entry.expiresAt < Date.now()) return null
  return { appId: entry.appId, userId: entry.userId }
}
