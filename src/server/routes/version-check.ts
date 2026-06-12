import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { userProfiles } from '@/server/db/schema'
import { config } from '@/server/config'
import {
  checkForUpdates,
  getCachedVersionInfo,
  getUpdateChannel,
  setUpdateChannel,
} from '@/server/services/version-check'
import { getLastUpdateRun, startSelfUpdate } from '@/server/services/self-update'
import type { AppVariables } from '@/server/app'
import type { Context, Next } from 'hono'

const versionCheckRoutes = new Hono<{ Variables: AppVariables }>()

const requireAdmin = async (c: Context<{ Variables: AppVariables }>, next: Next) => {
  const currentUser = c.get('user')
  const profile = db
    .select({ role: userProfiles.role })
    .from(userProfiles)
    .where(eq(userProfiles.userId, currentUser.id))
    .get()

  if (!profile || profile.role !== 'admin') {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Admin access required' } }, 403)
  }
  await next()
}

// GET /api/version-check — cached version info + changelog (all authenticated users)
versionCheckRoutes.get('/', async (c) => {
  if (!config.versionCheck.enabled) {
    const channel = await getUpdateChannel()
    return c.json({
      currentVersion: config.version,
      currentSha: null,
      channel,
      installationType: config.environment.installationType,
      latestVersion: null,
      isUpdateAvailable: false,
      canSelfUpdate: false,
      selfUpdateBlockedReason: null,
      releaseUrl: null,
      changelog: [],
      publishedAt: null,
      lastCheckedAt: null,
    })
  }

  return c.json(await getCachedVersionInfo())
})

// POST /api/version-check/check — force a fresh check (admin only)
versionCheckRoutes.post('/check', requireAdmin, async (c) => {
  if (!config.versionCheck.enabled) {
    return c.json({ error: { code: 'DISABLED', message: 'Version check is disabled' } }, 400)
  }
  return c.json(await checkForUpdates())
})

// PUT /api/version-check/channel — switch stable/edge (admin only)
versionCheckRoutes.put('/channel', requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null)
  const channel = body?.channel
  if (channel !== 'stable' && channel !== 'edge') {
    return c.json(
      { error: { code: 'INVALID_CHANNEL', message: "channel must be 'stable' or 'edge'" } },
      400,
    )
  }
  await setUpdateChannel(channel)
  // Refresh against the new channel right away so the response is coherent.
  const info = config.versionCheck.enabled ? await checkForUpdates() : await getCachedVersionInfo()
  return c.json(info)
})

// POST /api/version-check/update — apply the available update (admin only).
// Returns immediately; progress flows over SSE (`update:progress`) and the
// final outcome survives the restart in GET /last-update.
versionCheckRoutes.post('/update', requireAdmin, async (c) => {
  const result = await startSelfUpdate()
  if (!result.ok) {
    const status = result.error?.code === 'UPDATE_IN_PROGRESS' ? 409 : 400
    return c.json({ error: result.error }, status)
  }
  return c.json({ started: true, runId: result.runId })
})

// GET /api/version-check/last-update — latest update attempt (poll across restart)
versionCheckRoutes.get('/last-update', async (c) => {
  return c.json({ run: getLastUpdateRun() })
})

export { versionCheckRoutes }
