import { eq } from 'drizzle-orm'
import { existsSync, mkdirSync } from 'fs'
import { db } from '@/server/db/index'
import { agents } from '@/server/db/schema'
import { config } from '@/server/config'
import { sseManager } from '@/server/sse/index'
import { createLogger } from '@/server/logger'
import {
  resolveImageTarget,
  getMaxImageInputs,
  isImg2imgEnabled,
  getBaseAvatarBytes,
  buildAvatarPrompt,
  generateAvatarImage,
} from '@/server/services/image-generation'

const log = createLogger('avatar-regen')

/**
 * Per-agent outcome inside a bulk-regeneration job. `ok:false` carries the
 * error message so the UI can surface which agents failed (one failure never
 * aborts the batch).
 */
export interface BulkAvatarResult {
  agentId: string
  name: string
  ok: boolean
  error?: string
}

/**
 * In-memory snapshot of a bulk avatar regeneration. A single job runs at a
 * time (the process is single-instance). The snapshot survives after the
 * request returns so the modal can hydrate live progress on reopen via
 * `getBulkAvatarJob()`, and SSE (`avatar-bulk:*`) drives incremental updates.
 */
export interface BulkAvatarJob {
  id: string
  status: 'running' | 'done'
  /** The agents enrolled in this job (in processing order) — lets a reopened
   *  modal mark not-yet-processed rows as pending vs not-in-job. */
  agentIds: string[]
  total: number
  done: number
  succeeded: number
  failed: number
  /** Agent currently being generated (null when idle/finished). Drives the
   *  in-progress spinner on the matching row in the client. */
  currentAgentId: string | null
  results: BulkAvatarResult[]
  startedAt: number
  finishedAt: number | null
}

let currentJob: BulkAvatarJob | null = null

/** Current (or last completed) bulk job snapshot, for modal hydration. */
export function getBulkAvatarJob(): BulkAvatarJob | null {
  return currentJob
}

/**
 * Persist freshly generated avatar bytes for an agent: write the file, point
 * `agents.avatar_path` at it, and broadcast `agent:updated` so every connected
 * client refreshes the thumbnail live. Returns the cache-busted avatar URL.
 *
 * This is the persistence half of `POST /api/agents/:id/avatar` (the upload
 * route) — kept separate so the bulk job can generate-and-save in one server
 * step without the preview/confirm round-trip the per-agent UI uses.
 */
export async function persistAgentAvatar(
  agentId: string,
  bytes: Uint8Array,
  mediaType: string,
): Promise<string> {
  const ext = mediaType.includes('webp') ? 'webp' : 'png'
  const avatarDir = `${config.upload.dir}/agents/${agentId}`
  if (!existsSync(avatarDir)) {
    mkdirSync(avatarDir, { recursive: true })
  }
  const filePath = `${avatarDir}/avatar.${ext}`
  await Bun.write(filePath, bytes)

  await db
    .update(agents)
    .set({ avatarPath: filePath, updatedAt: new Date() })
    .where(eq(agents.id, agentId))

  const avatarUrl = `/api/uploads/agents/${agentId}/avatar.${ext}?v=${Date.now()}`
  sseManager.broadcast({
    type: 'agent:updated',
    agentId,
    data: { agentId, avatarUrl },
  })
  return avatarUrl
}

/**
 * Generate + persist one agent's avatar through the normal "auto" flow: the
 * prompt writer derives everything from the agent identity, guided by the
 * GLOBAL style/subject, with the img2img base attached when the chosen model
 * supports it. Mirrors the `mode:'auto'` branch of the per-agent generate route.
 */
async function regenerateOneAvatar(
  agent: { id: string; name: string; role: string; character: string; expertise: string },
  target: { providerId: string; modelId: string; maxImageInputs: number },
  supportsEdit: boolean,
  baseBytes: Uint8Array | null,
): Promise<void> {
  const prompt = await buildAvatarPrompt(
    {
      name: agent.name,
      role: agent.role,
      character: agent.character ?? '',
      expertise: agent.expertise ?? '',
    },
    supportsEdit ? 'edit' : 'generate',
    { targetModelId: target.modelId, maxImageInputs: target.maxImageInputs },
  )

  const result = await generateAvatarImage(prompt, {
    providerId: target.providerId,
    modelId: target.modelId,
    ...(supportsEdit && baseBytes ? { imageDatas: [baseBytes] } : {}),
  })

  const bytes = new Uint8Array(Buffer.from(result.base64, 'base64'))
  await persistAgentAvatar(agent.id, bytes, result.mediaType)
}

/**
 * Kick off a background bulk regeneration for the given agent ids. Resolves the
 * image target + img2img support once, then processes agents SEQUENTIALLY
 * (gentle on the upstream provider; ordering is irrelevant). The async loop is
 * intentionally NOT awaited — the caller returns immediately with the initial
 * snapshot and the job continues server-side, emitting `avatar-bulk:progress`
 * per agent and `avatar-bulk:done` at the end.
 *
 * Throws if a job is already running, or if no usable image provider exists
 * (propagated from `resolveImageTarget`).
 */
export async function startBulkAvatarRegen(
  agentIds: string[],
  target?: { providerId?: string; modelId?: string },
): Promise<BulkAvatarJob> {
  if (currentJob?.status === 'running') {
    throw new Error('A bulk avatar regeneration is already running')
  }

  // Resolve the image target + img2img support ONCE — identical for every
  // agent in the batch. Throws ImageGenerationError if no provider is usable.
  const resolved = await resolveImageTarget({
    providerId: target?.providerId,
    modelId: target?.modelId,
  })
  const maxImageInputs = await getMaxImageInputs(resolved.providerId, resolved.modelId)
  const supportsEdit = maxImageInputs > 0 && (await isImg2imgEnabled())
  const baseBytes = supportsEdit ? await getBaseAvatarBytes() : null

  const job: BulkAvatarJob = {
    id: crypto.randomUUID(),
    status: 'running',
    agentIds: [...agentIds],
    total: agentIds.length,
    done: 0,
    succeeded: 0,
    failed: 0,
    currentAgentId: null,
    results: [],
    startedAt: Date.now(),
    finishedAt: null,
  }
  currentJob = job

  // Fire-and-forget: process the batch without blocking the HTTP response. The
  // whole iteration is guarded so no single agent (or a DB read) can escape as
  // an unhandled rejection and abort the rest of the batch.
  void (async () => {
    for (const agentId of agentIds) {
      job.currentAgentId = agentId
      broadcastProgress(job, 'start', agentId)
      let agentName = agentId
      try {
        const agent = await db.select().from(agents).where(eq(agents.id, agentId)).get()
        if (!agent) throw new Error('Agent not found')
        agentName = agent.name
        await regenerateOneAvatar(
          {
            id: agent.id,
            name: agent.name,
            role: agent.role,
            character: agent.character,
            expertise: agent.expertise,
          },
          { providerId: resolved.providerId, modelId: resolved.modelId, maxImageInputs },
          supportsEdit,
          baseBytes,
        )
        job.done += 1
        job.succeeded += 1
        job.results.push({ agentId, name: agentName, ok: true })
        broadcastProgress(job, 'result', agentId, true)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Avatar generation failed'
        job.done += 1
        job.failed += 1
        job.results.push({ agentId, name: agentName, ok: false, error: message })
        log.warn({ agentId, err }, 'Bulk avatar regeneration failed for agent')
        broadcastProgress(job, 'result', agentId, false, message)
      }
    }

    job.currentAgentId = null
    job.status = 'done'
    job.finishedAt = Date.now()
    log.info(
      { jobId: job.id, total: job.total, succeeded: job.succeeded, failed: job.failed },
      'Bulk avatar regeneration finished',
    )
    sseManager.broadcast({
      type: 'avatar-bulk:done',
      data: {
        jobId: job.id,
        total: job.total,
        succeeded: job.succeeded,
        failed: job.failed,
        results: job.results,
      },
    })
  })()

  return job
}

function broadcastProgress(
  job: BulkAvatarJob,
  phase: 'start' | 'result',
  agentId: string,
  ok?: boolean,
  error?: string,
): void {
  sseManager.broadcast({
    type: 'avatar-bulk:progress',
    agentId,
    data: {
      jobId: job.id,
      phase,
      agentId,
      ...(ok !== undefined ? { ok } : {}),
      ...(error ? { error } : {}),
      done: job.done,
      total: job.total,
      succeeded: job.succeeded,
      failed: job.failed,
      currentAgentId: job.currentAgentId,
    },
  })
}
