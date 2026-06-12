#!/usr/bin/env bun
/**
 * Validate the marketing-site i18n dictionaries (site/src/i18n/locales/*.ts)
 * against the English reference:
 *  - identical key paths (arrays must keep the same length)
 *  - identical {placeholder} tokens per string
 *  - identical inline HTML tag sets per string (<b>, <a>, <code>, ...)
 *  - no em-dashes
 *
 * Usage: bun scripts/check-site-locales.ts
 */
import { readdirSync } from 'fs'
import { join } from 'path'

const LOCALES_DIR = join(import.meta.dir, '..', 'site', 'src', 'i18n', 'locales')

type Tree = Record<string, unknown>

function flatten(node: unknown, prefix = '', out: Map<string, string> = new Map()): Map<string, string> {
  if (Array.isArray(node)) {
    node.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out))
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Tree)) {
      flatten(value, prefix ? `${prefix}.${key}` : key, out)
    }
  } else {
    out.set(prefix, String(node))
  }
  return out
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort().join(',')
const htmlTags = (s: string) => [...s.matchAll(/<\/?([a-z][a-z0-9]*)\b/gi)].map((m) => m[1]!.toLowerCase()).sort().join(',')

const files = readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.ts'))
const ref = flatten((await import(join(LOCALES_DIR, 'en.ts'))).default)

let failed = false
for (const file of files) {
  if (file === 'en.ts') continue
  const locale = flatten((await import(join(LOCALES_DIR, file))).default)

  const missing = [...ref.keys()].filter((k) => !locale.has(k))
  const extra = [...locale.keys()].filter((k) => !ref.has(k))
  const badPh: string[] = []
  const badHtml: string[] = []
  const emDashes: string[] = []
  for (const [key, value] of locale) {
    const refValue = ref.get(key)
    if (refValue !== undefined) {
      if (placeholders(refValue) !== placeholders(value)) badPh.push(key)
      if (htmlTags(refValue) !== htmlTags(value)) badHtml.push(key)
    }
    if (value.includes('—')) emDashes.push(key)
  }

  const problems = missing.length + extra.length + badPh.length + badHtml.length + emDashes.length
  if (problems === 0) {
    console.log(`OK   ${file} (${locale.size} strings)`)
    continue
  }
  failed = true
  console.error(`FAIL ${file}`)
  const show = (label: string, keys: string[]) => {
    if (keys.length === 0) return
    console.error(`  ${label} (${keys.length}): ${keys.slice(0, 12).join(', ')}${keys.length > 12 ? ', …' : ''}`)
  }
  show('missing keys', missing)
  show('extra keys', extra)
  show('placeholder mismatch', badPh)
  show('html tag mismatch', badHtml)
  show('em-dashes', emDashes)
}

const refEmDashes = [...ref.entries()].filter(([, v]) => v.includes('—')).map(([k]) => k)
if (refEmDashes.length > 0) {
  failed = true
  console.error(`FAIL en.ts: em-dashes (${refEmDashes.length}): ${refEmDashes.slice(0, 12).join(', ')}`)
} else {
  console.log(`OK   en.ts (${ref.size} strings, reference)`)
}

process.exit(failed ? 1 : 0)
