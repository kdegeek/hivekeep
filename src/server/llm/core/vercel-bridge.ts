/**
 * Conversion helpers between the Vercel AI SDK shapes still used at the
 * boundary of agent-engine and the hivekeep `LLMProvider` abstraction.
 *
 * These helpers exist because:
 *   - Tool definitions still use the Vercel `tool({...})` shape — they're
 *     declared in ~37 `src/server/tools/*` files and all import the helper
 *     through `@/server/tools/tool-helper` (the one place where the Vercel
 *     SDK is still referenced).
 *   - `buildMessageHistory` internally builds `ModelMessage[]` to share its
 *     mask + size-cap transformations with the rest of the Vercel-shape
 *     codebase; it converts to `HivekeepMessage[]` at the very end of the
 *     function. Porting those transformations to `HivekeepMessage` is the
 *     final piece needed to drop `ai` from package.json.
 */

import type { ModelMessage } from '@/server/tools/tool-helper'
import { asSchema } from '@/server/tools/tool-helper'
import type { Tool } from '@/server/tools/tool-helper'
import type {
  HivekeepMessage,
  HivekeepMessageBlock,
  HivekeepTool,
} from '@/server/llm/llm/types'

// ─── Tools ───────────────────────────────────────────────────────────────────

/**
 * Convert a Vercel `Record<string, Tool>` into the hivekeep tool shape.
 *
 * Each tool's `inputSchema` can be a zod schema, a Vercel `Schema` wrapper,
 * a JSON Schema raw object, or anything `asSchema()` accepts. We normalize
 * via the SDK's `asSchema()` which always exposes `.jsonSchema` (sync for
 * zod and JSON Schema, async for schemas with deferred resolution — rare,
 * but supported here since the loops calling us are already async).
 *
 * Ensures the resulting schema is always an `object`-typed schema with a
 * `properties` field, even when empty — required by OpenAI's strict tool
 * schema validation ("object schema missing properties").
 */
export async function vercelToolsToHivekeep(tools: Record<string, Tool>): Promise<HivekeepTool[]> {
  const out: HivekeepTool[] = []
  for (const [name, tool] of Object.entries(tools)) {
    const description = (tool as { description?: string }).description ?? ''
    const raw = (tool as { inputSchema?: unknown }).inputSchema
    let json: Record<string, unknown>
    try {
      const wrapped = asSchema(raw as Parameters<typeof asSchema>[0])
      const resolved = await Promise.resolve(wrapped.jsonSchema)
      json = (resolved && typeof resolved === 'object' ? resolved : {}) as Record<string, unknown>
    } catch {
      json = {}
    }
    // OpenAI rejects function tools whose schema lacks `properties`. Ensure
    // both `type: 'object'` and `properties: {}` are set when missing.
    if (!json.type) json.type = 'object'
    if (json.type === 'object' && !('properties' in json)) {
      json.properties = {}
    }
    out.push({ name, description, inputSchema: json })
  }
  return out
}

/**
 * Add a `cache_control: ephemeral` breakpoint on the last tool of the list,
 * so Anthropic caches the whole tools block as a single prefix. No-op when
 * the list is empty. Pure (returns a new array).
 */
export function markLastHivekeepToolCacheable(tools: HivekeepTool[]): HivekeepTool[] {
  if (tools.length === 0) return tools
  return tools.map((t, i) =>
    i === tools.length - 1 ? { ...t, cacheControl: { type: 'ephemeral' as const } } : t,
  )
}

// ─── Messages ────────────────────────────────────────────────────────────────

/**
 * Convert a Vercel `ModelMessage[]` history into hivekeep `HivekeepMessage[]`.
 *
 * The Vercel shape:
 *   - `{ role: 'user', content: string | Array<TextPart|ImagePart|FilePart|ToolResultPart> }`
 *   - `{ role: 'assistant', content: string | Array<TextPart|ReasoningPart|ToolCallPart> }`
 *   - `{ role: 'tool', content: Array<ToolResultPart> }`  ← OpenAI-style tool messages
 *   - `{ role: 'system', content: string }`  ← rare in history; the chat
 *     request's `system` field is where the system prompt actually lives
 *
 * hivekeep collapses `role: 'tool'` messages into `role: 'user'` messages whose
 * content is a list of `tool-result` blocks (Anthropic-style). Providers that
 * need OpenAI-style separate tool messages (openai-key) re-split internally.
 *
 * Cache breakpoints are no longer carried at the `ModelMessage` level — the
 * new pipeline (see `llm-cache-hints.ts`) places `cacheControl` directly on
 * `HivekeepMessageBlock`s. This function therefore makes no attempt to read
 * `providerOptions.anthropic.cacheControl`.
 */
export function modelMessagesToHivekeep(messages: ModelMessage[]): HivekeepMessage[] {
  const out: HivekeepMessage[] = []
  for (const m of messages) {
    const role = m.role
    if (role === 'system') continue
    if (role === 'user') {
      out.push({ role: 'user', content: userContentToBlocks(m.content) })
      continue
    }
    if (role === 'assistant') {
      out.push({ role: 'assistant', content: assistantContentToBlocks(m.content) })
      continue
    }
    if (role === 'tool') {
      // OpenAI-style tool message → hivekeep user message of tool-result blocks.
      const blocks: HivekeepMessageBlock[] = []
      const content = m.content
      if (Array.isArray(content)) {
        for (const p of content) {
          const part = p as { type?: string; toolCallId?: string; toolName?: string; output?: unknown; result?: unknown }
          if (part?.type === 'tool-result') {
            blocks.push({
              type: 'tool-result',
              toolUseId: part.toolCallId ?? '',
              content: stringifyToolResult(part.output ?? part.result),
            })
          }
        }
      }
      if (blocks.length > 0) out.push({ role: 'user', content: blocks })
      continue
    }
  }
  return out
}

/**
 * Convert any tool result value into the plain-text string that goes into a
 * `HivekeepMessage` `tool-result` block. Handles the wrapped shapes used by the
 * Vercel SDK (`{ type: 'json', value }`, `{ type: 'text', value/text }`) and
 * falls back to `JSON.stringify` for arbitrary objects.
 *
 * Exported for the in-loop appends in agent-engine / tasks where freshly
 * executed tool results are appended directly to a `HivekeepMessage[]` history.
 */
export function stringifyToolResultValue(output: unknown): string {
  if (output == null) return ''
  if (typeof output === 'string') return output
  // OpenAI tool result outputs are sometimes wrapped: { type: 'json', value: ... } or
  // { type: 'text', value: '...' }. Unwrap when recognized, else JSON-stringify.
  if (typeof output === 'object') {
    const o = output as { type?: string; value?: unknown; text?: string }
    if (o.type === 'text' && typeof o.value === 'string') return o.value
    if (o.type === 'text' && typeof o.text === 'string') return o.text
    if (o.type === 'json') return JSON.stringify(o.value)
  }
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

/** @internal Kept as a thin alias so internal callers don't need updating. */
function stringifyToolResult(output: unknown): string {
  return stringifyToolResultValue(output)
}

function userContentToBlocks(content: unknown): HivekeepMessageBlock[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const blocks: HivekeepMessageBlock[] = []
  for (const p of content) {
    const part = p as { type?: string; text?: string; image?: unknown; data?: unknown; mediaType?: string; mimeType?: string; toolCallId?: string; output?: unknown; result?: unknown }
    if (part?.type === 'text' && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text })
    } else if (part?.type === 'image') {
      const data = coerceImageBytes(part.image ?? part.data)
      if (data) {
        blocks.push({ type: 'image', data, mediaType: part.mediaType ?? part.mimeType ?? 'image/png' })
      }
    } else if (part?.type === 'tool-result') {
      blocks.push({
        type: 'tool-result',
        toolUseId: part.toolCallId ?? '',
        content: stringifyToolResult(part.output ?? part.result),
      })
    }
  }
  return blocks
}

function assistantContentToBlocks(content: unknown): HivekeepMessageBlock[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const blocks: HivekeepMessageBlock[] = []
  for (const p of content) {
    const part = p as {
      type?: string
      text?: string
      toolCallId?: string
      toolName?: string
      input?: unknown
      signature?: string
    }
    if (part?.type === 'text' && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text })
    } else if (part?.type === 'reasoning' && typeof part.text === 'string') {
      blocks.push({ type: 'thinking', text: part.text, signature: part.signature })
    } else if (part?.type === 'tool-call' && part.toolCallId && part.toolName) {
      blocks.push({ type: 'tool-use', id: part.toolCallId, name: part.toolName, args: part.input })
    }
  }
  return blocks
}

function coerceImageBytes(value: unknown): Uint8Array | null {
  if (!value) return null
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (typeof value === 'string') {
    // Data URL or raw base64
    const base64 = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value
    try {
      const binary = globalThis.atob(base64)
      const out = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
      return out
    } catch {
      return null
    }
  }
  return null
}
