/**
 * In-app OAuth sign-in for the CLI-free subscription LLM providers
 * (`anthropic-oauth`, `openai-codex`). PKCE public-client authorization-code
 * flow, run in a "paste the code" shape so it works headless / behind a proxy
 * with no real callback round-trip:
 *
 *   POST /api/providers/oauth/:type/start     → { authUrl, state }
 *   POST /api/providers/oauth/:type/complete  → exchange code, persist tokens
 *                                               in the vault, create/update the
 *                                               provider row, return it.
 *
 * The provider's auth module reads/refreshes the vault-backed tokens at runtime
 * (see `_oauth-token-store.ts`); this route only owns the initial exchange.
 * The CLI-credentials-file path remains a separate, untouched alternative.
 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db } from '@/server/db/index'
import { providers } from '@/server/db/schema'
import { encrypt } from '@/server/services/encryption'
import { getCapabilitiesForType, testProviderConnection } from '@/server/providers/index'
import { reconcileProvider } from '@/server/services/model-registry'
import { generateProviderSlug } from '@/server/services/provider-slug'
import { sseManager } from '@/server/sse/index'
import { PROVIDER_META, type ProviderType } from '@/shared/provider-metadata'
import { createLogger } from '@/server/logger'
import {
  generatePkce,
  buildPkceAuthorizeUrl,
  exchangePkceCode,
  parsePastedCode,
  type PkceTokenResponse,
} from '@/server/llm/llm/_oauth-pkce'
import {
  writeTokenBundle,
  oauthVaultKey,
  PROVIDER_ID_KEY,
  PROVIDER_TYPE_KEY,
  type OAuthTokenBundle,
} from '@/server/llm/llm/_oauth-token-store'
import { getLLMProvider } from '@/server/llm/llm/registry'

const log = createLogger('routes:provider-oauth')
const providerOAuthRoutes = new Hono()

/**
 * The OAuth wiring is DECLARED on the provider (`LLMProvider.oauth`) — no
 * hand-maintained registry here. A provider (built-in or plugin) that declares
 * an `oauth` descriptor automatically supports the in-app sign-in. Returns
 * undefined for types that don't (or aren't registered / are non-LLM).
 */
function getOAuthEntry(type: string) {
  return getLLMProvider(type)?.oauth
}

// Short-lived store for in-flight PKCE flows (verifier is secret, never leaves
// the server). Keyed by the state we generated.
const pendingFlows = new Map<string, { type: string; verifier: string; createdAt: number }>()
const FLOW_TTL_MS = 10 * 60 * 1000

function sweepFlows(): void {
  const cutoff = Date.now() - FLOW_TTL_MS
  for (const [k, v] of pendingFlows) if (v.createdAt < cutoff) pendingFlows.delete(k)
}

// POST /api/providers/oauth/:type/start — begin the PKCE flow.
providerOAuthRoutes.post('/:type/start', async (c) => {
  const type = c.req.param('type')
  const entry = getOAuthEntry(type)
  if (!entry) {
    return c.json(
      { error: { code: 'NOT_OAUTH_SIGNIN', message: `${type} does not support in-app sign-in` } },
      400,
    )
  }
  sweepFlows()
  const { verifier, challenge } = generatePkce()
  const state = uuid()
  pendingFlows.set(state, { type, verifier, createdAt: Date.now() })
  const authUrl = buildPkceAuthorizeUrl({ client: entry.client, challenge, state })
  return c.json({ authUrl, state })
})

// POST /api/providers/oauth/:type/complete — finish the flow.
// Body: { state, code, name?, providerId? }
//   - code may be the bare code, Anthropic's `<code>#<state>`, or a full
//     redirect URL; parsePastedCode normalises all three.
//   - providerId (optional) re-authenticates an existing row in place.
providerOAuthRoutes.post('/:type/complete', async (c) => {
  const type = c.req.param('type')
  const entry = getOAuthEntry(type)
  if (!entry) {
    return c.json(
      { error: { code: 'NOT_OAUTH_SIGNIN', message: `${type} does not support in-app sign-in` } },
      400,
    )
  }

  type CompleteBody = { state?: string; code?: string; name?: string; providerId?: string }
  const body: CompleteBody = await c.req.json<CompleteBody>().catch(() => ({} as CompleteBody))
  if (!body.state || !body.code) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'state and code are required' } }, 400)
  }
  const flow = pendingFlows.get(body.state)
  if (!flow || flow.type !== type) {
    return c.json({ error: { code: 'INVALID_STATE', message: 'Sign-in session expired — start again.' } }, 400)
  }
  pendingFlows.delete(body.state)

  const parsed = parsePastedCode(body.code)
  if (!parsed.code) {
    return c.json({ error: { code: 'INVALID_CODE', message: 'Could not read an authorization code from the input.' } }, 400)
  }

  // Exchange the code for tokens.
  let tokens: PkceTokenResponse
  try {
    tokens = await exchangePkceCode({
      client: entry.client,
      code: parsed.code,
      verifier: flow.verifier,
      // Prefer the state the provider echoed back in the pasted value.
      state: parsed.state ?? body.state,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token exchange failed'
    log.warn({ type, err: message }, 'OAuth code exchange failed')
    return c.json({ error: { code: 'EXCHANGE_FAILED', message } }, 400)
  }
  if (!tokens.refreshToken) {
    return c.json(
      { error: { code: 'NO_REFRESH_TOKEN', message: 'The provider did not return a refresh token — try again.' } },
      400,
    )
  }

  const bundle: OAuthTokenBundle = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
    ...(entry.buildExtra ? { extra: entry.buildExtra(tokens) } : {}),
  }
  // Drop an undefined `extra` so the shape stays clean.
  if (bundle.extra === undefined) delete bundle.extra

  // Reconnecting an existing provider, or creating a new one.
  const existing = body.providerId
    ? await db.select().from(providers).where(eq(providers.id, body.providerId)).get()
    : undefined
  const id = existing?.id ?? uuid()

  // Persist tokens in the vault under the row's deterministic key.
  await writeTokenBundle(oauthVaultKey(type, id), bundle)

  // Validate against the live API (tokens are fresh, so this just probes the
  // model list). Thread the row identity so the vault bundle is found.
  const meta = PROVIDER_META[type as ProviderType]
  const probeConfig: Record<string, string> = {
    authMode: 'signin',
    [PROVIDER_ID_KEY]: id,
    [PROVIDER_TYPE_KEY]: type,
  }
  const testResult = await testProviderConnection(type, probeConfig)

  const config = { authMode: 'signin' }
  const configEncrypted = await encrypt(JSON.stringify(config))
  const capabilities = getCapabilitiesForType(type)

  if (existing) {
    await db
      .update(providers)
      .set({
        configEncrypted,
        capabilities: JSON.stringify(capabilities),
        isValid: testResult.valid,
        lastError: testResult.valid ? null : (testResult.error ?? null),
        updatedAt: new Date(),
      })
      .where(eq(providers.id, id))
    if (testResult.valid) void reconcileProvider(id).catch(() => {})
    sseManager.broadcast({
      type: 'provider:updated',
      data: {
        providerId: id,
        slug: existing.slug,
        name: existing.name,
        providerType: type,
        capabilities,
        isValid: testResult.valid,
        lastError: testResult.valid ? null : (testResult.error ?? null),
      },
    })
    log.info({ providerId: id, type, isValid: testResult.valid }, 'Provider re-authenticated via sign-in')
    return c.json({
      provider: { id, slug: existing.slug, name: existing.name, type, capabilities, isValid: testResult.valid },
    })
  }

  const name = body.name?.trim() || meta?.displayName || type
  const slug = generateProviderSlug(name)
  await db.insert(providers).values({
    id,
    slug,
    name,
    type,
    configEncrypted,
    capabilities: JSON.stringify(capabilities),
    isValid: testResult.valid,
    lastError: testResult.valid ? null : (testResult.error ?? null),
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  if (testResult.valid) await reconcileProvider(id)
  sseManager.broadcast({
    type: 'provider:created',
    data: { providerId: id, slug, name, providerType: type, capabilities, isValid: testResult.valid },
  })
  log.info({ providerId: id, slug, type, isValid: testResult.valid }, 'Provider created via sign-in')

  return c.json({ provider: { id, slug, name, type, capabilities, isValid: testResult.valid } }, 201)
})

export { providerOAuthRoutes }
