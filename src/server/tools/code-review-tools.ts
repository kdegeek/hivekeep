import { z } from 'zod'
import { tool } from '@/server/tools/tool-helper'
import type { ToolRegistration } from '@/server/tools/types'
import { isAbsolute, relative, resolve } from 'node:path'
import { resolveToolEnv, resolveToolWorkspace } from '@/server/tools/workspace'
import { checkCodeRabbitAuth, checkKiloAuth, listLocalReviewers, runLocalCodeReview } from '@/server/services/local-review'

function resolveRepoPath(ctx: Parameters<typeof resolveToolWorkspace>[0], repoPath?: string): string {
  const workspace = resolveToolWorkspace(ctx)
  if (!repoPath) return workspace
  const resolved = resolve(repoPath)
  const rel = relative(workspace, resolved)
  if (rel === '' || (!rel.startsWith('..') && rel !== '..' && !isAbsolute(rel))) return resolved
  throw new Error('repo_path must stay inside the current tool workspace/worktree')
}

function reviewCliEnv(ctx: Parameters<typeof resolveToolEnv>[0]): Record<string, string | undefined> {
  return resolveToolEnv(ctx, { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' })
}

const providerSchema = z.enum(['coderabbit', 'kilo', 'all']).default('all')

export const listLocalReviewersTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) => tool({
    description: 'List first-class local code review providers/agents available to Hivekeep (CodeRabbit and Kilo Code), including CLI install/auth status. Does not run a review.',
    inputSchema: z.object({ repo_path: z.string().optional().describe('Repository path. Defaults to the current tool workspace/worktree.') }),
    execute: async ({ repo_path }) => listLocalReviewers(resolveRepoPath(ctx, repo_path), reviewCliEnv(ctx)),
  }),
}

export const checkCodeReviewAuthTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) => tool({
    description: 'Check local review CLI authentication/status for CodeRabbit and/or Kilo Code. Never asks for or prints secrets; it only reports CLI auth/doctor output.',
    inputSchema: z.object({
      provider: providerSchema.describe('Reviewer provider to check.'),
      repo_path: z.string().optional().describe('Repository path. Defaults to the current tool workspace/worktree.'),
    }),
    execute: async ({ provider, repo_path }) => {
      const repoPath = resolveRepoPath(ctx, repo_path)
      const env = reviewCliEnv(ctx)
      if (provider === 'coderabbit') return { reviewers: [await checkCodeRabbitAuth(repoPath, env)] }
      if (provider === 'kilo') return { reviewers: [await checkKiloAuth(repoPath, env)] }
      return { reviewers: await listLocalReviewers(repoPath, env) }
    },
  }),
}

export const runLocalCodeReviewTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  create: (ctx) => tool({
    description: 'Run dedicated local code review tasks through first-class reviewer agents backed by CodeRabbit CLI and/or Kilo CLI. Produces structured findings, durable JSON artifacts, and a blocking/advisory gate decision for pre-push/PR workflows.',
    inputSchema: z.object({
      provider: providerSchema.describe('Reviewer to run. all runs CodeRabbit then Kilo.'),
      repo_path: z.string().optional().describe('Repository path. Defaults to the current tool workspace/worktree.'),
      base: z.string().optional().describe('Base branch/ref for diff review, e.g. origin/main.'),
      base_commit: z.string().optional().describe('Base commit SHA when available.'),
      head: z.string().optional().describe('Head branch/ref/SHA being reviewed.'),
      mode: z.enum(['advisory', 'blocking']).optional().describe('blocking prevents automatic push/PR when major/critical findings are present.'),
      light: z.boolean().optional().describe('Use lightweight review mode where the provider supports it. Defaults true.'),
      timeout_ms: z.number().int().min(1000).optional().describe('Per-reviewer timeout in milliseconds.'),
    }),
    execute: async ({ provider, repo_path, base, base_commit, head, mode, light, timeout_ms }) => runLocalCodeReview({
      repoPath: resolveRepoPath(ctx, repo_path),
      provider,
      base,
      baseCommit: base_commit,
      head,
      mode,
      light,
      timeoutMs: timeout_ms,
      agentId: ctx.agentId,
      env: reviewCliEnv(ctx),
    }),
  }),
}
