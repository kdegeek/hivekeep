import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  WorkspaceFolderError,
  listWorkspaceFolders,
  createWorkspaceFolder,
  deleteWorkspaceFolder,
} from '@/server/services/workspace-folders'
import type { AppVariables } from '@/server/app'

/**
 * CRUD for user-added arbitrary FS folders shown in the Files selector.
 * Mounted on /api/workspace-folders. Open to every authenticated user
 * (decision: same access as agent workspaces).
 */
const workspaceFolderRoutes = new Hono<{ Variables: AppVariables }>()

const ERROR_STATUS: Record<string, 400 | 404> = {
  INVALID_LABEL: 400,
  INVALID_PATH: 400,
  NOT_A_DIRECTORY: 400,
  PATH_BLOCKED: 400,
  NOT_FOUND: 404,
}

function handleError(c: Context, err: unknown) {
  if (err instanceof WorkspaceFolderError) {
    return c.json({ error: { code: err.code, message: err.message } }, ERROR_STATUS[err.code] ?? 400)
  }
  throw err
}

// GET /api/workspace-folders
workspaceFolderRoutes.get('/', (c) => c.json({ folders: listWorkspaceFolders() }))

// POST /api/workspace-folders — { label, path }
workspaceFolderRoutes.post('/', async (c) => {
  const body = await c.req.json<{ label?: string; path?: string }>()
  try {
    const folder = createWorkspaceFolder({
      label: body.label ?? '',
      path: body.path ?? '',
      userId: c.get('user')?.id ?? null,
    })
    return c.json({ folder }, 201)
  } catch (err) {
    return handleError(c, err)
  }
})

// DELETE /api/workspace-folders/:id
workspaceFolderRoutes.delete('/:id', (c) => {
  const ok = deleteWorkspaceFolder(c.req.param('id'))
  if (!ok) return c.json({ error: { code: 'NOT_FOUND', message: 'Folder not found' } }, 404)
  return c.json({ success: true })
})

export { workspaceFolderRoutes }
