#!/usr/bin/env bun
/**
 * Validate UI locale files against the reference locale (en.json):
 *  - every locale has exactly the same key paths (no missing, no extra)
 *  - every translated string keeps the same i18next interpolations ({{var}})
 *  - no em-dashes (banned in user-facing copy)
 *
 * Usage: bun scripts/check-locales.ts
 * Exits non-zero on any mismatch, printing a per-locale report.
 */
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const LOCALES_DIR = join(import.meta.dir, '..', 'src', 'client', 'locales')
const REFERENCE = 'en.json'

type Json = Record<string, unknown>

function flatten(obj: Json, prefix = '', out: Map<string, string> = new Map()): Map<string, string> {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object') {
      flatten(value as Json, path, out)
    } else {
      out.set(path, String(value))
    }
  }
  return out
}

function interpolations(s: string): string[] {
  return [...s.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]!).sort()
}

const files = readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json'))
const ref = flatten(JSON.parse(readFileSync(join(LOCALES_DIR, REFERENCE), 'utf8')))

let failed = false

for (const file of files) {
  if (file === REFERENCE) continue
  const locale = flatten(JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8')))

  // Languages with richer plural systems (ru, pl, …) legitimately add forms the
  // English reference doesn't have (_few, _many, …); ja/zh may drop _one.
  const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/
  const isPluralVariant = (k: string, of: Map<string, string>) =>
    PLURAL_SUFFIX.test(k) && of.has(`${k.replace(PLURAL_SUFFIX, '')}_other`)

  const missing = [...ref.keys()].filter((k) => !locale.has(k) && !isPluralVariant(k, locale))
  const extra = [...locale.keys()].filter((k) => !ref.has(k) && !isPluralVariant(k, ref))
  const badInterp: string[] = []
  const emDashes: string[] = []

  for (const [key, value] of locale) {
    const refValue = ref.get(key)
    if (refValue !== undefined && interpolations(refValue).join(',') !== interpolations(value).join(',')) {
      badInterp.push(key)
    }
    if (value.includes('—')) emDashes.push(key)
  }

  const problems = missing.length + extra.length + badInterp.length + emDashes.length
  if (problems === 0) {
    console.log(`OK   ${file} (${locale.size} keys)`)
    continue
  }

  failed = true
  console.error(`FAIL ${file}`)
  const show = (label: string, keys: string[]) => {
    if (keys.length === 0) return
    console.error(`  ${label} (${keys.length}): ${keys.slice(0, 15).join(', ')}${keys.length > 15 ? ', …' : ''}`)
  }
  show('missing keys', missing)
  show('extra keys', extra)
  show('interpolation mismatch', badInterp)
  show('em-dashes', emDashes)
}

// The reference itself must not contain em-dashes either.
const refEmDashes = [...ref.entries()].filter(([, v]) => v.includes('—')).map(([k]) => k)
if (refEmDashes.length > 0) {
  failed = true
  console.error(`FAIL ${REFERENCE}: em-dashes (${refEmDashes.length}): ${refEmDashes.slice(0, 15).join(', ')}${refEmDashes.length > 15 ? ', …' : ''}`)
} else {
  console.log(`OK   ${REFERENCE} (${ref.size} keys, reference)`)
}

process.exit(failed ? 1 : 0)
