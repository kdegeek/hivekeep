import { Hono } from 'hono'
import type { AppVariables } from '@/server/app'
import { createLogger } from '@/server/logger'
import { getPluginCardWithOwner } from '@/server/services/plugin-cards'
import { pluginManager } from '@/server/services/plugins'

const log = createLogger('routes:plugin-cards')

const pluginCardRoutes = new Hono<{ Variables: AppVariables }>()

// POST /api/plugin-cards/:cardInstanceId/action
//
// Dispatches a user click on an action button to the owning plugin via its
// `onCardAction` export. Auth is the standard session check enforced by the
// `/api/*` middleware: any authenticated user can act on any card in this
// instance, mirroring the rest of the per-Agent surface area.
pluginCardRoutes.post('/:cardInstanceId/action', async (c) => {
  const cardInstanceId = c.req.param('cardInstanceId')
  if (!cardInstanceId) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'cardInstanceId is required' } }, 400)
  }

  let body: { actionId?: string; input?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Request body must be JSON' } }, 400)
  }
  const actionId = body.actionId
  const input = typeof body.input === 'string' ? body.input : undefined
  if (!actionId || typeof actionId !== 'string') {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'actionId is required' } }, 400)
  }

  const owner = await getPluginCardWithOwner(cardInstanceId)
  if (!owner) {
    return c.json({ error: { code: 'CARD_NOT_FOUND', message: 'Card not found' } }, 404)
  }

  const plugin = pluginManager.getPlugin(owner.card.pluginId)
  if (!plugin || !plugin.enabled || !plugin.exports) {
    return c.json({ error: { code: 'PLUGIN_UNAVAILABLE', message: `Plugin "${owner.card.pluginId}" is not currently loaded` } }, 503)
  }
  const handler = plugin.exports.onCardAction
  if (typeof handler !== 'function') {
    return c.json({ error: { code: 'ACTION_UNSUPPORTED', message: `Plugin "${owner.card.pluginId}" does not handle card actions` } }, 400)
  }

  try {
    const result = await handler({
      cardInstanceId,
      actionId,
      input,
      agentId: owner.agentId,
    })
    if (!result?.ok) {
      const errMsg = (result && 'error' in result && typeof result.error === 'string') ? result.error : 'Action failed'
      return c.json({ error: { code: 'ACTION_FAILED', message: errMsg } }, 400)
    }
    return c.json({ ok: true })
  } catch (err) {
    log.error(
      { err, pluginId: owner.card.pluginId, cardInstanceId, actionId },
      'onCardAction threw',
    )
    const message = err instanceof Error ? err.message : 'Plugin handler crashed'
    return c.json({ error: { code: 'ACTION_CRASHED', message } }, 500)
  }
})

export { pluginCardRoutes }
