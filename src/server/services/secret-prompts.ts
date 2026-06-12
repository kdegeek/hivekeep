/**
 * Secure input — the user types a secret (API key / token) into a UI popup and
 * it goes straight to the vault; the LLM never sees it.
 *
 * Flow (mirrors human-prompts but secret-safe):
 *   1. A tool (request_provider_setup / prompt_secret) calls createSecretPrompt,
 *      which emits `prompt:secret-request` over SSE and returns a promptId. The
 *      Agent's turn ends, waiting.
 *   2. The user fills the popup; the client POSTs the raw values to
 *      /api/secret-prompts/:id/respond.
 *   3. respondToSecretPrompt stores the secret in the vault and performs the
 *      side effect (create + test a provider, or just store the secret), then
 *      injects a NON-SENSITIVE confirmation message that resumes the Agent's turn.
 *
 * The raw secret is never written to `secret_prompts`, never logged, never
 * placed in a `messages` row, and never returned to the LLM.
 */

import { eq } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db, sqlite } from '@/server/db/index'
import { secretPrompts, providers, tasks, messages } from '@/server/db/schema'
import { sseManager } from '@/server/sse/index'
import { enqueueMessage } from '@/server/services/queue'
import { encrypt } from '@/server/services/encryption'
import { createSecret, getSecretByKey, updateSecret, getSecretValue } from '@/server/services/vault'
import { eventBus } from '@/server/services/events'
import { vaultifyProviderConfig } from '@/server/services/provider-config'
import { testProviderConnection, getCapabilitiesForType } from '@/server/providers/index'
import { generateProviderSlug } from '@/server/services/provider-slug'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import type { SecretPromptField, SecretPromptPurpose } from '@/shared/types'

const log = createLogger('secret-prompts')

const FAMILY_ORDER = ['llm', 'embedding', 'image', 'search', 'tts', 'stt'] as const

/** Purpose-specific spec persisted as JSON on the prompt row. */
export interface ProviderSecretSpec {
  type: string
  name: string
  families?: string[]
  /** Non-secret config fields (baseUrl, etc.) supplied by the Agent up front. */
  config?: Record<string, string>
}
export interface VaultSecretSpec {
  key: string
}
export interface RevealSecretSpec {
  key: string
  reason: string
}
export interface ChannelSecretSpec {
  platform: string
  name: string
  agentId: string
  /** Non-secret config fields (allowedChatIds, etc.). */
  config?: Record<string, unknown>
}

interface CreateSecretPromptParams {
  agentId: string
  taskId?: string
  purpose: SecretPromptPurpose
  title: string
  description?: string
  /** Secret fields the user must fill (rendered as masked inputs). */
  fields: SecretPromptField[]
  /** Purpose-specific data (ProviderSecretSpec | VaultSecretSpec). */
  spec: Record<string, unknown>
}

export async function createSecretPrompt(params: CreateSecretPromptParams): Promise<{ promptId: string }> {
  const promptId = uuid()
  await db.insert(secretPrompts).values({
    id: promptId,
    agentId: params.agentId,
    taskId: params.taskId ?? null,
    purpose: params.purpose,
    spec: JSON.stringify({ ...params.spec, fields: params.fields, title: params.title, description: params.description ?? null }),
    status: 'pending',
    createdAt: new Date(),
  })

  // Suspend the task (free the global exec slot) when in a task context.
  if (params.taskId) {
    const task = await db.select().from(tasks).where(eq(tasks.id, params.taskId)).get()
    if (task) {
      await db.update(tasks).set({ status: 'awaiting_human_input', updatedAt: new Date() }).where(eq(tasks.id, params.taskId))
      import('@/server/services/tasks')
        .then(({ promoteGlobalQueue }) => promoteGlobalQueue().catch(() => {}))
        .catch(() => {})
    }
  }

  sseManager.sendToAgent(params.agentId, {
    type: 'prompt:secret-request',
    agentId: params.agentId,
    data: {
      promptId,
      agentId: params.agentId,
      purpose: params.purpose,
      title: params.title,
      description: params.description ?? null,
      fields: params.fields,
    },
  })

  // Persistent "action required" notification (fire-and-forget).
  import('@/server/services/notifications')
    .then(({ createNotification }) =>
      createNotification({
        type: 'prompt:pending',
        title: 'Secure input needed',
        body: params.title,
        agentId: params.agentId,
        relatedId: promptId,
        relatedType: 'prompt',
      }).catch(() => {}),
    )
    .catch(() => {})

  log.info({ promptId, agentId: params.agentId, purpose: params.purpose, fields: params.fields.map((f) => f.key) }, 'Secret prompt created')
  return { promptId }
}

// ─── Respond ────────────────────────────────────────────────────────────────

export async function respondToSecretPrompt(
  promptId: string,
  values: Record<string, string>,
  userId?: string,
): Promise<{ success: true; summary: string } | { success: false; error: string }> {
  const prompt = await db.select().from(secretPrompts).where(eq(secretPrompts.id, promptId)).get()
  if (!prompt) return { success: false, error: 'Prompt not found' }
  if (prompt.status !== 'pending') return { success: false, error: 'Prompt is no longer pending' }

  const spec = JSON.parse(prompt.spec) as Record<string, unknown> & { fields: SecretPromptField[] }
  const fields = spec.fields ?? []

  // Validate: every secret field must have a non-empty value.
  for (const f of fields) {
    const v = values[f.key]
    if (f.secret && (!v || v.trim() === '')) {
      return { success: false, error: `Missing value for "${f.label}".` }
    }
  }

  let resultRef: Record<string, unknown> = {}
  let summary = ''
  let confirmationOverride: string | undefined
  let messageMetadata: Record<string, unknown> | undefined

  try {
    if (prompt.purpose === 'provider') {
      const ps = spec as unknown as ProviderSecretSpec
      const rawConfig: Record<string, string> = { ...(ps.config ?? {}), ...values }

      const testResult = await testProviderConnection(ps.type, rawConfig)

      const allCaps = getCapabilitiesForType(ps.type)
      const allFamilies = FAMILY_ORDER.filter((f) => (allCaps as readonly string[]).includes(f))
      const capabilities = ps.families && ps.families.length > 0
        ? allFamilies.filter((f) => ps.families!.includes(f))
        : allFamilies
      if (capabilities.length === 0) {
        // Throw (not early-return): the catch below finalizes the prompt and
        // resumes the Agent. A bare return here would leave it `pending` and
        // re-fire on every reload — the same trap as a swallowed exception.
        throw new Error(`Provider type "${ps.type}" supports no usable capability.`)
      }

      const id = uuid()
      const vaulted = await vaultifyProviderConfig(ps.type, id, rawConfig, prompt.agentId)
      const configEncrypted = await encrypt(JSON.stringify(vaulted))
      const slug = generateProviderSlug(ps.name)
      const now = new Date()
      await db.insert(providers).values({
        id,
        slug,
        name: ps.name,
        type: ps.type,
        configEncrypted,
        capabilities: JSON.stringify(capabilities),
        isValid: testResult.valid,
        lastError: testResult.valid ? null : (testResult.error ?? null),
        createdAt: now,
        updatedAt: now,
      })
      sseManager.broadcast({
        type: 'provider:created',
        data: { providerId: id, slug, name: ps.name, providerType: ps.type, capabilities, isValid: testResult.valid },
      })
      resultRef = { providerId: id, valid: testResult.valid, capabilities }
      summary = testResult.valid
        ? `Provider "${ps.name}" (${ps.type}) configured and tested OK. Capabilities: ${capabilities.join(', ')}. Provider id: ${slug}.`
        : `Provider "${ps.name}" (${ps.type}) was saved but the credentials test FAILED: ${testResult.error ?? 'unknown error'}. Ask the user to double-check the key.`
      log.info({ promptId, providerId: id, type: ps.type, valid: testResult.valid }, 'Provider created from secure input')
    } else if (prompt.purpose === 'vault') {
      const vs = spec as unknown as VaultSecretSpec
      const storedKeys: string[] = []
      for (const f of fields) {
        if (!f.secret) continue
        // Upsert: the user is actively entering this credential, so re-submitting
        // a key that already exists should UPDATE it, not crash on the vault's
        // UNIQUE(key) constraint (which was swallowed into "Failed to apply" and,
        // worse, left the prompt pending → re-prompted forever).
        const existing = await getSecretByKey(f.key)
        if (existing) {
          await updateSecret(existing.id, { value: values[f.key]!, description: f.label })
        } else {
          await createSecret(f.key, values[f.key]!, prompt.agentId, f.label)
        }
        storedKeys.push(f.key)
      }
      resultRef = { vaultKeys: storedKeys }
      const placeholders = storedKeys.map((k) => `{{secret:${k}}}`).join(', ')
      summary =
        `Secret${storedKeys.length > 1 ? 's' : ''} stored in the vault: ${storedKeys.join(', ')}. ` +
        `Use the placeholder${storedKeys.length > 1 ? 's' : ''} ${placeholders} verbatim in tool arguments — the real value is substituted at execution time and is never shown to you.`
      log.info({ promptId, keys: storedKeys }, 'Secret(s) stored from secure input')
    } else if (prompt.purpose === 'reveal') {
      const rs = spec as unknown as RevealSecretSpec
      const value = await getSecretValue(rs.key)
      if (value === null) {
        throw new Error(`Secret "${rs.key}" no longer exists in the vault.`)
      }
      resultRef = { revealedKey: rs.key }
      // The raw value travels ONLY in the resume message (confirmationOverride):
      // `summary` is broadcast over SSE and returned to the HTTP caller, so it
      // must stay non-sensitive. The carrier message is flagged for end-of-turn
      // redaction via the `reveal` metadata (redactPending is set at insert).
      summary = `the user approved revealing secret "${rs.key}" to the model for this turn.`
      confirmationOverride =
        `[Secure input received — the user APPROVED revealing secret "${rs.key}". ` +
        `Raw value (visible for THIS turn only; it will be redacted from the history when the turn ends): ${value}]`
      messageMetadata = { reveal: { key: rs.key } }
      eventBus.emit({
        type: 'vault:secret-revealed',
        data: { agentId: prompt.agentId, secretKey: rs.key, approved: true },
        timestamp: Date.now(),
      })
      log.info({ promptId, key: rs.key }, 'Secret revealed to the model with user approval')
    } else if (prompt.purpose === 'channel') {
      const cs = spec as unknown as ChannelSecretSpec
      const { createChannel, activateChannel } = await import('@/server/services/channels')
      // createChannel auto-vaults the password fields; pass raw secret values + non-secret config.
      const channel = await createChannel({
        agentId: cs.agentId,
        name: cs.name,
        platform: cs.platform as Parameters<typeof createChannel>[0]['platform'],
        platformConfig: { ...(cs.config ?? {}), ...values },
        createdBy: 'agent',
      })
      const activated = await activateChannel(channel.id)
      const ok = activated?.status === 'active'
      resultRef = { channelId: channel.id, status: activated?.status ?? 'inactive' }
      summary = ok
        ? `Channel "${cs.name}" (${cs.platform}) created and activated.`
        : `Channel "${cs.name}" (${cs.platform}) was created but activation FAILED: ${activated?.statusMessage ?? 'unknown error'}. Ask the user to double-check the token / settings.`
      log.info({ promptId, channelId: channel.id, platform: cs.platform, ok }, 'Channel created from secure input')
    } else {
      throw new Error(`Unsupported secret prompt purpose: ${prompt.purpose}`)
    }
  } catch (err) {
    log.error({ promptId, purpose: prompt.purpose, err }, 'Secret prompt side effect failed')
    // A thrown side effect MUST still take the prompt out of `pending` and resume
    // the Agent — otherwise the prompt re-fires on every reload/SSE-resync (it was
    // never advanced) and the user is re-prompted forever. Mirror the provider
    // "saved but test failed" philosophy: finalize + resume with a failure note.
    await finalizeSecretPrompt(prompt, {
      ok: false,
      status: 'answered',
      summary: 'the secure input could not be applied (an unexpected error occurred). Apologize and offer to try again.',
      confirmationPrefix: 'Secure input failed',
      resultRef: { error: 'side-effect-failed' },
      userId,
    })
    return { success: false, error: 'Failed to apply the secure input. Please try again.' }
  }

  await finalizeSecretPrompt(prompt, {
    ok: true,
    status: 'answered',
    summary,
    confirmationPrefix: 'Secure input received',
    resultRef,
    userId,
    confirmationOverride,
    messageMetadata,
  })

  return { success: true, summary }
}

/**
 * Cancel a pending secure-input prompt: the user dismissed the popup without
 * providing the value. Takes the prompt out of `pending` (so it never re-fires)
 * and resumes the Agent / sub-Agent with a neutral "declined" note so a suspended
 * task can't hang forever.
 */
export async function cancelSecretPrompt(
  promptId: string,
  userId?: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const prompt = await db.select().from(secretPrompts).where(eq(secretPrompts.id, promptId)).get()
  if (!prompt) return { success: false, error: 'Prompt not found' }
  if (prompt.status !== 'pending') return { success: true } // already resolved — idempotent

  const isReveal = prompt.purpose === 'reveal'
  let cancelSummary = 'the user dismissed the secure-input request and did not provide the value.'
  if (isReveal) {
    cancelSummary = 'the user DENIED revealing the secret. Do not ask again unless they change their mind — work with the placeholder instead.'
    try {
      const spec = JSON.parse(prompt.spec) as { key?: string }
      eventBus.emit({
        type: 'vault:secret-revealed',
        data: { agentId: prompt.agentId, secretKey: spec.key ?? null, approved: false },
        timestamp: Date.now(),
      })
    } catch { /* spec unreadable — event skipped */ }
  }

  await finalizeSecretPrompt(prompt, {
    ok: false,
    status: 'cancelled',
    summary: cancelSummary,
    confirmationPrefix: isReveal ? 'Reveal denied' : 'Secure input dismissed',
    resultRef: { cancelled: true },
    userId,
  })
  log.info({ promptId, agentId: prompt.agentId }, 'Secret prompt cancelled by user')
  return { success: true }
}

/**
 * Shared terminal step for a secret prompt: advance it out of `pending`, inject a
 * non-sensitive confirmation message that resumes the Agent (or claims+resumes a
 * suspended sub-Agent task), and broadcast `prompt:secret-resolved` so every open
 * modal closes. Used by the success, handled-failure, and cancel paths alike.
 */
async function finalizeSecretPrompt(
  prompt: { id: string; agentId: string; taskId: string | null },
  opts: {
    ok: boolean
    status: 'answered' | 'cancelled'
    summary: string
    confirmationPrefix: string
    resultRef: Record<string, unknown>
    userId?: string
    /** Full resume-message content when it must differ from the SSE-safe
     *  summary (reveal: the raw value rides ONLY here). */
    confirmationOverride?: string
    /** Sideband metadata for the resume message (e.g. { reveal: { key } } —
     *  flags the carrier for end-of-turn redaction). */
    messageMetadata?: Record<string, unknown>
  },
): Promise<void> {
  await db
    .update(secretPrompts)
    .set({ status: opts.status, resultRef: JSON.stringify(opts.resultRef), respondedAt: new Date() })
    .where(eq(secretPrompts.id, prompt.id))

  const confirmation = opts.confirmationOverride ?? `[${opts.confirmationPrefix} — ${opts.summary}]`

  if (prompt.taskId) {
    const claim = sqlite.run(
      `UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'awaiting_human_input'`,
      [Date.now(), prompt.taskId],
    )
    if (claim.changes > 0) {
      await db.insert(messages).values({
        id: uuid(),
        agentId: prompt.agentId,
        taskId: prompt.taskId,
        role: 'user',
        content: confirmation,
        sourceType: 'user',
        sourceId: opts.userId ?? null,
        metadata: opts.messageMetadata ? JSON.stringify(opts.messageMetadata) : null,
        redactPending: !!(opts.messageMetadata as { reveal?: unknown } | undefined)?.reveal,
        createdAt: new Date(),
      })
      const { runOrQueueResumedTask } = await import('@/server/services/tasks')
      runOrQueueResumedTask(prompt.taskId).catch((err) =>
        log.error({ taskId: prompt.taskId, err }, 'Sub-Agent resume error after secret prompt'),
      )
    }
  } else {
    await enqueueMessage({
      agentId: prompt.agentId,
      messageType: 'user',
      content: confirmation,
      sourceType: 'user',
      sourceId: opts.userId,
      priority: config.queue.userPriority,
      messageMetadata: opts.messageMetadata,
    })
  }

  sseManager.sendToAgent(prompt.agentId, {
    type: 'prompt:secret-resolved',
    agentId: prompt.agentId,
    data: { promptId: prompt.id, agentId: prompt.agentId, ok: opts.ok, summary: opts.summary },
  })
}

export async function getPendingSecretPrompts(agentId: string) {
  const rows = await db
    .select()
    .from(secretPrompts)
    .where(eq(secretPrompts.agentId, agentId))
    .all()
  return rows
    .filter((r) => r.status === 'pending')
    .map((r) => {
      const spec = JSON.parse(r.spec) as { fields: SecretPromptField[]; title?: string; description?: string | null }
      return {
        promptId: r.id,
        agentId: r.agentId,
        purpose: r.purpose as SecretPromptPurpose,
        title: spec.title ?? 'Secure input needed',
        description: spec.description ?? null,
        fields: spec.fields ?? [],
      }
    })
}
