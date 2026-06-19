import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  WorkspaceFilesError,
  listInTarget,
  readInTarget,
  statForRawInTarget,
  writeInTarget,
  mkdirInTarget,
  moveInTargets,
  copyInTargets,
  deleteInTarget,
  uploadInTarget,
  searchInTarget,
  type WorkspaceTarget,
} from '@/server/services/workspace-files'
import { resolveWorkspaceSource, WorkspaceSourceError, type ResolveSourceOpts } from '@/server/services/workspace-sources'
import { listProjectWorktrees, gitStatusSummary } from '@/server/services/workspace-git'
import { isInlineSafeMime } from '@/server/services/file-kind'
import type { WorkspaceSourceRef } from '@/shared/types'
import type { AppVariables } from '@/server/app'

/**
 * Generalized Files API — browses any workspace source (agent / project /
 * folder), see files.md (extended). Mounted on /api/workspace/:sourceType/:sourceId.
 *
 * Agent-scoped chat integrations (search palette, resolve-paths) keep their own
 * /api/agents/:agentId/workspace/* routes; this family powers the Files PAGE for
 * every source type and delegates to the same root-based service functions.
 */
const workspaceSourceRoutes = new Hono<{ Variables: AppVariables }>()

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
  SOURCE_NOT_FOUND: 404,
  SOURCE_NOT_READY: 409,
  SOURCE_INVALID: 400,
}

function handleError(c: Context, err: unknown) {
  if (err instanceof WorkspaceFilesError || err instanceof WorkspaceSourceError) {
    return c.json({ error: { code: err.code, message: err.message } }, ERROR_STATUS[err.code] ?? 400)
  }
  throw err
}

function sourceOpts(c: Context): ResolveSourceOpts {
  const worktree = c.req.query('worktree')
  return worktree ? { worktree } : {}
}

/** Resolve the route's :sourceType/:sourceId (+ ?worktree) to a target. */
function resolveRouteTarget(c: Context): Promise<WorkspaceTarget> {
  return resolveWorkspaceSource(c.req.param('sourceType') ?? '', c.req.param('sourceId') ?? '', sourceOpts(c))
}

// GET /api/workspace/:type/:id/ls?path=docs
workspaceSourceRoutes.get('/ls', async (c) => {
  try {
    const target = await resolveRouteTarget(c)
    return c.json(await listInTarget(target, c.req.query('path') ?? ''))
  } catch (err) {
    return handleError(c, err)
  }
})

// GET /api/workspace/:type/:id/file?path=…
workspaceSourceRoutes.get('/file', async (c) => {
  try {
    const target = await resolveRouteTarget(c)
    return c.json(await readInTarget(target, c.req.query('path') ?? ''))
  } catch (err) {
    return handleError(c, err)
  }
})

// PUT /api/workspace/:type/:id/file
workspaceSourceRoutes.put('/file', async (c) => {
  const body = await c.req.json<{ path?: string; content?: string; baseModifiedAt?: number; createOnly?: boolean }>()
  if (typeof body.path !== 'string' || typeof body.content !== 'string') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'path and content are required' } }, 400)
  }
  try {
    const target = await resolveRouteTarget(c)
    const result = await writeInTarget(target, body.path, body.content, {
      baseModifiedAt: typeof body.baseModifiedAt === 'number' ? body.baseModifiedAt : undefined,
      createOnly: body.createOnly === true,
    })
    return c.json(result)
  } catch (err) {
    return handleError(c, err)
  }
})

// POST /api/workspace/:type/:id/mkdir
workspaceSourceRoutes.post('/mkdir', async (c) => {
  const body = await c.req.json<{ path?: string }>()
  if (typeof body.path !== 'string') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'path is required' } }, 400)
  }
  try {
    const target = await resolveRouteTarget(c)
    return c.json(await mkdirInTarget(target, body.path))
  } catch (err) {
    return handleError(c, err)
  }
})

/** Build the source target for the `fromSource` of a cross-source move/copy. */
async function resolveFromSource(c: Context, fromSource: WorkspaceSourceRef | undefined, dest: WorkspaceTarget): Promise<WorkspaceTarget> {
  if (!fromSource) return dest
  return resolveWorkspaceSource(fromSource.type, fromSource.id, fromSource.worktree ? { worktree: fromSource.worktree } : {})
}

// POST /api/workspace/:type/:id/move — cross-source via body.fromSource
workspaceSourceRoutes.post('/move', async (c) => {
  const body = await c.req.json<{ from?: string; to?: string; fromSource?: WorkspaceSourceRef }>()
  if (typeof body.from !== 'string' || typeof body.to !== 'string') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'from and to are required' } }, 400)
  }
  try {
    const destTarget = await resolveRouteTarget(c)
    const sourceTarget = await resolveFromSource(c, body.fromSource, destTarget)
    return c.json(await moveInTargets({ sourceTarget, destTarget, from: body.from, to: body.to }))
  } catch (err) {
    return handleError(c, err)
  }
})

// POST /api/workspace/:type/:id/copy
workspaceSourceRoutes.post('/copy', async (c) => {
  const body = await c.req.json<{ from?: string; to?: string; fromSource?: WorkspaceSourceRef }>()
  if (typeof body.from !== 'string' || typeof body.to !== 'string') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'from and to are required' } }, 400)
  }
  try {
    const destTarget = await resolveRouteTarget(c)
    const sourceTarget = await resolveFromSource(c, body.fromSource, destTarget)
    return c.json(await copyInTargets({ sourceTarget, destTarget, from: body.from, to: body.to }))
  } catch (err) {
    return handleError(c, err)
  }
})

// DELETE /api/workspace/:type/:id/file?path=…
workspaceSourceRoutes.delete('/file', async (c) => {
  try {
    const target = await resolveRouteTarget(c)
    const result = await deleteInTarget(target, c.req.query('path') ?? '')
    return c.json({ deleted: true, path: result.path })
  } catch (err) {
    return handleError(c, err)
  }
})

// POST /api/workspace/:type/:id/upload — multipart
workspaceSourceRoutes.post('/upload', async (c) => {
  const formData = await c.req.formData()
  const dirPath = (formData.get('path') as string | null) ?? ''
  const entries = formData.getAll('file').filter((f): f is File => f instanceof File)
  if (entries.length === 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'At least one file is required' } }, 400)
  }
  try {
    const target = await resolveRouteTarget(c)
    const files = await Promise.all(
      entries.map(async (f) => ({ name: f.name, buffer: Buffer.from(await f.arrayBuffer()) })),
    )
    return c.json(await uploadInTarget(target, dirPath, files), 201)
  } catch (err) {
    return handleError(c, err)
  }
})

// GET /api/workspace/:type/:id/search?q=…&limit=20
workspaceSourceRoutes.get('/search', async (c) => {
  const q = c.req.query('q') ?? ''
  const limit = Number(c.req.query('limit') ?? 20)
  try {
    const target = await resolveRouteTarget(c)
    const hits = await searchInTarget(target, q, Number.isFinite(limit) ? limit : 20)
    return c.json({ hits })
  } catch (err) {
    return handleError(c, err)
  }
})

// GET /api/workspace/project/:projectId/worktrees — live worktrees of a repo
workspaceSourceRoutes.get('/worktrees', async (c) => {
  if (c.req.param('sourceType') !== 'project') return c.json({ worktrees: [] })
  try {
    return c.json({ worktrees: await listProjectWorktrees(c.req.param('sourceId') ?? '') })
  } catch (err) {
    return handleError(c, err)
  }
})

// GET /api/workspace/:type/:id/git-status — branch + dirty count (null if not a repo)
workspaceSourceRoutes.get('/git-status', async (c) => {
  try {
    const target = await resolveRouteTarget(c)
    return c.json({ gitStatus: await gitStatusSummary(target.root) })
  } catch (err) {
    return handleError(c, err)
  }
})

// GET /api/workspace/:type/:id/raw?path=…&inline=1
workspaceSourceRoutes.get('/raw', async (c) => {
  try {
    const target = await resolveRouteTarget(c)
    const file = await statForRawInTarget(target, c.req.query('path') ?? '')
    const inline = c.req.query('inline') === '1' && isInlineSafeMime(file.mimeType)
    const headers: Record<string, string> = {
      'Content-Type': file.mimeType,
      'Content-Length': String(file.size),
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    }
    if (inline) headers['Content-Security-Policy'] = "default-src 'none'; sandbox"
    return new Response(Bun.file(file.abs), { headers })
  } catch (err) {
    return handleError(c, err)
  }
})

export { workspaceSourceRoutes }
