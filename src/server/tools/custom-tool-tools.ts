import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import {
  createCustomTool,
  updateCustomTool,
  deleteCustomTool,
  listCustomTools,
  getCustomTool,
  writeCustomToolFile,
  runToolSetup,
  executeCustomTool,
} from '@/server/services/custom-tools'
import { customToolHasRenderer, validateCustomToolRenderer } from '@/server/services/custom-tool-renderer'
import {
  createToolDomain,
  listToolDomains,
  updateToolDomain,
  deleteToolDomain,
} from '@/server/services/tool-domains'
import { DOMAIN_COLOR_TOKENS } from '@/shared/constants'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:custom')

const errMsg = (err: unknown) => (err instanceof Error ? err.message : 'Unknown error')

/** UI-only localized overrides: per locale, an optional display name/description
 *  plus per-parameter label/description. NEVER changes the LLM tool definition —
 *  only how the tool is shown in the UI. Keyed by locale (en/fr/es/de). */
const translationsSchema = z
  .record(
    z.string(),
    z
      .object({
        name: z.string().optional(),
        description: z.string().optional(),
        parameters: z
          .record(
            z.string(),
            z.object({ label: z.string().optional(), description: z.string().optional() }).passthrough(),
          )
          .optional(),
      })
      .passthrough(),
  )
  .describe(
    'UI-only localized labels keyed by locale (en/fr/es/de): { "<locale>": { name?, description?, parameters?: { "<param>": { label?, description? } } } }. Does NOT affect the tool definition seen by the LLM.',
  )

/** Default entrypoint filename for a declared language. */
function defaultEntrypoint(language?: string): string {
  switch ((language ?? '').toLowerCase()) {
    case 'python':
    case 'py':
      return 'main.py'
    case 'node':
    case 'javascript':
    case 'js':
      return 'index.js'
    case 'bash':
      return 'run.sh'
    case 'sh':
      return 'run.sh'
    case 'deno':
      return 'main.ts'
    default:
      return 'index.ts' // bun / typescript
  }
}

// ─── Custom tool authoring (main agents only) ──────────────────────────────────

/**
 * create_custom_tool — author a NEW global custom tool. Creates the DB row +
 * managed directory. If `code` is supplied it's written to the entrypoint in
 * one shot. The tool is active immediately and becomes callable as
 * `custom_<slug>` once a toolbox grants it. Use write_custom_tool_file for
 * extra files and run_custom_tool_setup to install dependencies.
 */
export const createCustomToolTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Create a new GLOBAL custom tool (script in any language). Becomes callable as custom_<slug> once added to a toolbox. Provide a JSON-Schema for its parameters; the script reads args as JSON on stdin and writes its result to stdout. ALWAYS provide `translations` (human UI name, description, and parameter labels for en/fr/es/de) so the tool shows a proper localized name in the UI instead of the raw custom_<slug>.',
      inputSchema: z.object({
        slug: z.string().describe('Unique id, ^[a-z][a-z0-9_]*$ → tool name custom_<slug>. Immutable.'),
        name: z.string().describe('Human-readable name'),
        description: z.string().describe('What the tool does (shown to the LLM)'),
        parameters: z.string().describe('JSON Schema (object) of the tool input, as a string'),
        language: z
          .enum(['python', 'node', 'bun', 'typescript', 'bash', 'sh', 'deno'])
          .optional()
          .describe('Interpreter. If omitted, inferred from the entrypoint shebang/extension.'),
        entrypoint: z.string().optional().describe('Relative path of the script (default by language, e.g. main.py / index.ts)'),
        code: z.string().optional().describe('Optional: entrypoint file content, written immediately'),
        domainSlug: z.string().optional().describe("Tool domain slug for grouping (default 'custom')"),
        timeoutMs: z.number().int().positive().optional().describe('Per-tool execution timeout in ms (capped at server max)'),
        translations: translationsSchema.optional(),
      }),
      execute: async ({ slug, name, description, parameters, language, entrypoint, code, domainSlug, timeoutMs, translations }) => {
        log.debug({ slug }, 'create_custom_tool requested')
        try {
          const entry = entrypoint ?? defaultEntrypoint(language)
          const created = await createCustomTool({
            slug,
            name,
            description,
            parameters,
            entrypoint: entry,
            language: language ?? null,
            domainSlug: domainSlug ?? null,
            timeoutMs: timeoutMs ?? null,
            translations: translations ?? null,
            createdBy: 'agent',
          })
          if (code !== undefined) {
            await writeCustomToolFile(slug, entry, code)
          }
          return { success: true, slug: created.slug, toolName: `custom_${created.slug}`, entrypoint: entry, message: `Custom tool "${slug}" created` }
        } catch (err) {
          return { error: errMsg(err) }
        }
      },
    }),
}

/** write_custom_tool_file — write/overwrite a file inside the tool's dir. */
export const writeCustomToolFileTool: ToolRegistration = {
  availability: ['main'],
  create: () =>
    tool({
      description: "Write (or overwrite) a file inside a custom tool's directory (entrypoint, helper modules, requirements.txt, package.json, …).",
      inputSchema: z.object({
        slug: z.string(),
        path: z.string().describe("Relative path within the tool's directory"),
        content: z.string(),
      }),
      execute: async ({ slug, path, content }) => {
        try {
          await writeCustomToolFile(slug, path, content)
          return { success: true, message: `Wrote ${path}` }
        } catch (err) {
          return { error: errMsg(err) }
        }
      },
    }),
}

/** run_custom_tool_setup — install dependencies (requirements.txt / package.json). */
export const runCustomToolSetupTool: ToolRegistration = {
  availability: ['main'],
  create: () =>
    tool({
      description: "Install a custom tool's dependencies: requirements.txt → a .venv with pip; package.json → bun install. Run after writing the dep manifest.",
      inputSchema: z.object({ slug: z.string() }),
      execute: async ({ slug }) => {
        try {
          const res = await runToolSetup(slug)
          return res
        } catch (err) {
          return { error: errMsg(err) }
        }
      },
    }),
}

/** test_custom_tool — dry-run a custom tool by slug (works regardless of toolbox grants). */
export const testCustomToolTool: ToolRegistration = {
  availability: ['main'],
  create: () =>
    tool({
      description:
        'Execute a custom tool with sample args to test it (does not require the tool to be in a toolbox). Returns its output. If the tool ships a renderer.tsx, ALSO validates the renderer server-side (builds it + does an initial SSR render) and reports the result under `renderer`: { ok } on success, or { ok:false, phase:"build"|"render", error } when it is broken. Always check `renderer.ok` after writing a renderer — a renderer error is otherwise invisible (it runs in the user\'s browser). Note: validation runs the INITIAL render only — useEffect/handlers do not fire.',
      inputSchema: z.object({
        slug: z.string(),
        args: z.record(z.string(), z.unknown()).optional(),
        timeout: z.number().int().positive().optional(),
      }),
      execute: async ({ slug, args, timeout }) => {
        const callArgs = args ?? {}
        const result = await executeCustomTool(slug, callArgs, timeout)
        // When the tool ships a renderer, validate it in the SAME test so the Agent
        // sees front-end renderer health alongside the script output. Best-effort:
        // a validator-internal failure must not break the execution report.
        if (customToolHasRenderer(slug)) {
          try {
            const renderer = await validateCustomToolRenderer(slug, result, callArgs)
            return { ...result, renderer }
          } catch (err) {
            return { ...result, renderer: { ok: false, error: errMsg(err) } }
          }
        }
        return result
      },
    }),
}

/** update_custom_tool — edit metadata (slug is immutable). */
export const updateCustomToolTool: ToolRegistration = {
  availability: ['main'],
  create: () =>
    tool({
      description:
        "Update a custom tool's metadata (name, description, parameters schema, entrypoint, language, domain, timeout, enabled, translations). The slug is immutable. Use `translations` to set/refresh the localized UI labels (name/description/parameter labels per locale) — this is UI-only and never changes the LLM tool definition.",
      inputSchema: z.object({
        slug: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        parameters: z.string().optional().describe('JSON Schema string'),
        entrypoint: z.string().optional(),
        language: z.string().nullable().optional(),
        domainSlug: z.string().optional(),
        timeoutMs: z.number().int().positive().nullable().optional(),
        enabled: z.boolean().optional(),
        translations: translationsSchema.nullable().optional(),
      }),
      execute: async ({ slug, ...patch }) => {
        try {
          const updated = updateCustomTool(slug, patch)
          return { success: true, slug: updated.slug, enabled: updated.enabled }
        } catch (err) {
          return { error: errMsg(err) }
        }
      },
    }),
}

/** delete_custom_tool — remove a custom tool + its directory. */
export const deleteCustomToolTool: ToolRegistration = {
  availability: ['main'],
  destructive: true,
  create: () =>
    tool({
      description: "Delete a custom tool and its directory. Any toolbox still listing custom_<slug> will simply skip it.",
      inputSchema: z.object({ slug: z.string() }),
      execute: async ({ slug }) => {
        try {
          const ok = await deleteCustomTool(slug)
          return ok ? { success: true } : { error: 'Tool not found' }
        } catch (err) {
          return { error: errMsg(err) }
        }
      },
    }),
}

/** list_custom_tools — list all global custom tools. */
export const listCustomToolsTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: () =>
    tool({
      description: 'List all global custom tools (slug, name, description, domain, enabled, and which locales have UI translations).',
      inputSchema: z.object({}),
      execute: async () => {
        return {
          tools: listCustomTools().map((t) => {
            let translatedLocales: string[] = []
            if (t.translations) {
              try {
                const parsed = JSON.parse(t.translations) as Record<string, unknown>
                if (parsed && typeof parsed === 'object') translatedLocales = Object.keys(parsed)
              } catch {
                /* ignore malformed */
              }
            }
            return {
              slug: t.slug,
              toolName: `custom_${t.slug}`,
              name: t.name,
              description: t.description,
              domainSlug: t.domainSlug,
              entrypoint: t.entrypoint,
              language: t.language,
              enabled: t.enabled,
              translatedLocales,
            }
          }),
        }
      },
    }),
}

// ─── Tool domains (main agents only) ────────────────────────────────────────────

export const createToolDomainTool: ToolRegistration = {
  availability: ['main'],
  create: () =>
    tool({
      description: 'Create a custom tool domain to organize tools (icon + color + label). Use it as domainSlug when creating custom tools.',
      inputSchema: z.object({
        slug: z.string().describe('Lowercase id ^[a-z][a-z0-9-]*$'),
        label: z.string(),
        icon: z.string().describe('A Lucide icon name (e.g. "CloudSun", "Wallet")'),
        color: z.enum(DOMAIN_COLOR_TOKENS).describe('A curated color token'),
        description: z.string().optional(),
      }),
      execute: async ({ slug, label, icon, color, description }) => {
        try {
          const d = createToolDomain({ slug, label, icon, color, description })
          return { success: true, slug: d.slug }
        } catch (err) {
          return { error: errMsg(err) }
        }
      },
    }),
}

export const listToolDomainsTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: () =>
    tool({
      description: 'List all tool domains (built-in + custom) with their icon/color/label.',
      inputSchema: z.object({}),
      execute: async () => ({ domains: listToolDomains() }),
    }),
}

export const updateToolDomainTool: ToolRegistration = {
  availability: ['main'],
  create: () =>
    tool({
      description: 'Update a custom tool domain (built-in domains are read-only).',
      inputSchema: z.object({
        slug: z.string(),
        label: z.string().optional(),
        icon: z.string().optional(),
        color: z.enum(DOMAIN_COLOR_TOKENS).optional(),
        description: z.string().nullable().optional(),
      }),
      execute: async ({ slug, ...patch }) => {
        try {
          const d = updateToolDomain(slug, patch)
          return { success: true, slug: d.slug }
        } catch (err) {
          return { error: errMsg(err) }
        }
      },
    }),
}

export const deleteToolDomainTool: ToolRegistration = {
  availability: ['main'],
  destructive: true,
  create: () =>
    tool({
      description: 'Delete a custom tool domain (blocked if any custom tool still uses it).',
      inputSchema: z.object({ slug: z.string() }),
      execute: async ({ slug }) => {
        try {
          deleteToolDomain(slug)
          return { success: true }
        } catch (err) {
          return { error: errMsg(err) }
        }
      },
    }),
}
