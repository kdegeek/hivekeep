import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * Regression guard: every native tool registered in `register.ts` MUST have a
 * human-readable label under `tools.names.<tool_name>` in BOTH `en.json` and
 * `fr.json`. Without it the chat UI (ToolCallItem / InlineToolCall) and the Agent
 * tools settings tab fall back to the raw snake_case technical name, which is
 * the exact paper-cut this test exists to prevent.
 *
 * When you register a new native tool, add its label to all locales — start
 * with en.json (base) and fr.json (this test enforces both), then mirror into
 * es.json / de.json for completeness (those are best-effort, not enforced here
 * because they're partially translated by design).
 *
 * The test parses `register.ts` statically (regex) rather than importing the
 * tool tree, to avoid the import side effects (logger, hooks, DB) and Bun's
 * global `mock.module` pollution.
 */

const TOOLS_DIR = import.meta.dir
const REGISTER_PATH = resolve(TOOLS_DIR, 'register.ts')
const LOCALES_DIR = resolve(TOOLS_DIR, '../../client/locales')

function getRegisteredToolNames(): string[] {
  const src = readFileSync(REGISTER_PATH, 'utf-8')
  const names = new Set<string>()
  const re = /toolRegistry\.register\(\s*'([^']+)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    names.add(m[1]!)
  }
  return [...names].sort()
}

function getToolNameLabels(locale: string): Record<string, string> {
  const raw = readFileSync(resolve(LOCALES_DIR, `${locale}.json`), 'utf-8')
  const json = JSON.parse(raw) as { tools?: { names?: Record<string, string> } }
  return json.tools?.names ?? {}
}

describe('tool name i18n parity', () => {
  const registered = getRegisteredToolNames()

  it('finds a non-trivial number of registered tools', () => {
    // Sanity check the regex still matches the register.ts format.
    expect(registered.length).toBeGreaterThan(100)
  })

  for (const locale of ['en', 'fr'] as const) {
    it(`every registered native tool has a ${locale}.json label`, () => {
      const labels = getToolNameLabels(locale)
      const missing = registered.filter((name) => !labels[name])
      expect(missing).toEqual([])
    })
  }
})
