/**
 * Kinbot's tool definition helper + shared types.
 *
 * Every native tool, MCP-wrapped tool, and custom user tool is declared
 * through this module. Concentrating the Vercel coupling here means a
 * future swap (replace `tool()` with a native kinbot implementation that
 * doesn't reach into `ai`) is a one-file change rather than a 55-file
 * migration.
 *
 * The shape returned by `tool()` from `ai` is what `tool-executor`,
 * `kin-engine`, `tool-output-spill`, `mcp`, `custom-tools` and
 * `vercelToolsToKinbot` all expect — we re-export it under our own names
 * to keep the imports kinbot-rooted without changing any runtime behaviour.
 *
 * If/when we drop the Vercel SDK entirely (Bloc 3 in the refactor plan),
 * this file becomes the seam to replace: implement `tool()` natively,
 * define `Tool` from scratch, and the rest of the codebase doesn't move.
 */

export { tool, asSchema } from 'ai'
export type { Tool, JSONValue } from 'ai'
