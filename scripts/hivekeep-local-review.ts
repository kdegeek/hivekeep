#!/usr/bin/env bun
import { config } from '@/server/config'
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

function readMode(): ReviewMode {
  const raw = readArg('--mode') ?? process.env.HIVEKEEP_LOCAL_REVIEW_MODE ?? config.codeReview.defaultMode
  if (raw === 'advisory' || raw === 'blocking') return raw
  console.error(`Invalid review mode: ${raw}. Valid values: advisory, blocking`)
  process.exit(1)
}

function readProvider(): ReviewProvider | 'all' {
  const raw = readArg('--provider') ?? process.env.HIVEKEEP_LOCAL_REVIEW_PROVIDER ?? 'all'
  if (raw === 'coderabbit' || raw === 'kilo' || raw === 'all') return raw
  console.error(`Invalid review provider: ${raw}. Valid values: coderabbit, kilo, all`)
  process.exit(1)
}

const provider = readProvider()
const mode = readMode()
const repoPath = readArg('--repo') ?? process.cwd()
const base = readArg('--base') ?? process.env.HIVEKEEP_LOCAL_REVIEW_BASE
const baseCommit = readArg('--base-commit') ?? process.env.HIVEKEEP_LOCAL_REVIEW_BASE_COMMIT
const head = readArg('--head') ?? process.env.HIVEKEEP_LOCAL_REVIEW_HEAD
const light = !has('--full')

const result = await runLocalCodeReview({ repoPath, provider, mode, base, baseCommit, head, light })
console.log(JSON.stringify(result, null, 2))
if (result.blocked) process.exit(2)
if (result.status === 'failed' && result.mode === 'blocking') process.exit(1)
