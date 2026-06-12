import { Hono } from 'hono'
import type { Context } from 'hono'
import { resolveAgentByIdOrSlug } from '@/server/services/agent-resolver'
import {
  WorkspaceFilesError,
  listWorkspaceDir,
  readWorkspaceFile,
  statWorkspaceFileForRaw,
} from '@/server/services/workspace-files'
import { isInlineSafeMime } from '@/server/services/file-kind'
import type { AppVariables } from '@/server/app'

/**
 * Workspace files API — the user-facing Files section (see files.md § 6).
 * Mounted on /api/agents/:agentId/workspace.
 */
const workspaceFilesRoutes = new Hono<{ Variables: AppVariables }>()

const ERROR_STATUS: Record<string, 400 | 404 | 409 | 413> = {
  PATH_FORBIDDEN: 400,
  INVALID_NAME: 400,
  IS_DIRECTORY: 400,
  NOT_A_DIRECTORY: 400,
  FILE_NOT_FOUND: 404,
  DEST_EXISTS: 409,
  CONFLICT: 409,
  FILE_TOO_LARGE: 413,
  COPY_TOO_LARGE: 413,
}

function handleError(c: Context, err: unknown) {
  if (err instanceof WorkspaceFilesError) {
    return c.json({ error: { code: err.code, message: err.message } }, ERROR_STATUS[err.code] ?? 400)
  }
  throw err
}

/** Resolve :agentId (uuid or slug) or answer 404 — same convention as the other agent-nested routes. */
function requireAgent(c: Context) {
  const agent = resolveAgentByIdOrSlug(c.req.param('agentId') as string)
  if (!agent) return null
  return agent
}

const agentNotFound = (c: Context) =>
  c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)

// GET /api/agents/:agentId/workspace/ls?path=docs — list one directory
workspaceFilesRoutes.get('/ls', async (c) => {
  const agent = requireAgent(c)
  if (!agent) return agentNotFound(c)
  try {
    const result = await listWorkspaceDir(agent.id, c.req.query('path') ?? '')
    return c.json(result)
  } catch (err) {
    return handleError(c, err)
  }
})

// GET /api/agents/:agentId/workspace/file?path=… — read file metadata + text content
workspaceFilesRoutes.get('/file', async (c) => {
  const agent = requireAgent(c)
  if (!agent) return agentNotFound(c)
  try {
    const file = await readWorkspaceFile(agent.id, c.req.query('path') ?? '')
    return c.json(file)
  } catch (err) {
    return handleError(c, err)
  }
})

// GET /api/agents/:agentId/workspace/raw?path=…&inline=1 — stream raw bytes
workspaceFilesRoutes.get('/raw', async (c) => {
  const agent = requireAgent(c)
  if (!agent) return agentNotFound(c)
  try {
    const file = await statWorkspaceFileForRaw(agent.id, c.req.query('path') ?? '')
    const inline = c.req.query('inline') === '1' && isInlineSafeMime(file.mimeType)
    const headers: Record<string, string> = {
      'Content-Type': file.mimeType,
      'Content-Length': String(file.size),
      // MIME is guessed from the extension — never let the browser sniff its way around the allowlist.
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    }
    if (inline) headers['Content-Security-Policy'] = "default-src 'none'; sandbox"
    return new Response(Bun.file(file.abs), { headers })
  } catch (err) {
    return handleError(c, err)
  }
})

export { workspaceFilesRoutes }
