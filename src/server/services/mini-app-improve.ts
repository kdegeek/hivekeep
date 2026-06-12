/**
 * Format a mini-app "improve this app" request into a message that is enqueued
 * into the maintainer Agent's main conversation. Pure function (no I/O) so it can
 * be unit-tested without touching the DB/queue.
 *
 * The message frames the request for the maintainer and includes the app's
 * name/slug/id so the Agent can immediately act on it with its mini-app tools.
 */
export interface MiniAppImproveRequest {
  appName: string
  appSlug: string
  appId: string
  description: string
  requesterName: string
}

export function formatMiniAppImproveRequest(req: MiniAppImproveRequest): string {
  const { appName, appSlug, appId, description, requesterName } = req
  return (
    `🛠️ Improvement request for the mini-app "${appName}" (slug: ${appSlug}, id: ${appId}), ` +
    `sent from the app by ${requesterName}:\n\n` +
    `${description.trim()}\n\n` +
    `Please apply this to the mini-app using your mini-app tools (you can edit any app, ` +
    `not only ones you maintain).`
  )
}
