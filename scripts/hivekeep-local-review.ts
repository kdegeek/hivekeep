#!/usr/bin/env bun
import { runLocalCodeReview, type ReviewProvider, type ReviewMode } from '@/server/services/local-review'

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  if (i < 0) return undefined
  const value = process.argv[i + 1]
  return value && !value.startsWith('-') ? value : undefined
}

function has(name: string): boolean {
  return process.argv.includes(name)
}

const provider = (readArg('--provider') ?? process.env.HIVEKEEP_LOCAL_REVIEW_PROVIDER ?? 'all') as ReviewProvider | 'all'
const mode = (readArg('--mode') ?? process.env.HIVEKEEP_LOCAL_REVIEW_MODE ?? 'advisory') as ReviewMode
const repoPath = readArg('--repo') ?? process.cwd()
const base = readArg('--base') ?? process.env.HIVEKEEP_LOCAL_REVIEW_BASE
const baseCommit = readArg('--base-commit') ?? process.env.HIVEKEEP_LOCAL_REVIEW_BASE_COMMIT
const head = readArg('--head') ?? process.env.HIVEKEEP_LOCAL_REVIEW_HEAD
const light = !has('--full')

const result = await runLocalCodeReview({ repoPath, provider, mode, base, baseCommit, head, light })
console.log(JSON.stringify(result, null, 2))
if (result.blocked) process.exit(2)
if (result.status === 'failed' && mode === 'blocking') process.exit(1)
