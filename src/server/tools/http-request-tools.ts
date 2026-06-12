import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { createLogger } from '@/server/logger'
import type { ToolExecutionContext, ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:http-request')

const MAX_RESPONSE_BODY = 100 * 1024 // 100KB
const DEFAULT_TIMEOUT = 30_000

type UrlSafety =
  | { allowed: true }
  | { allowed: false; reason: string }

/**
 * Check whether a URL is safe for http_request.
 *
 * The TOOLBOX is the sole tool-grant primitive: there is no per-Agent network
 * flag. When `http_request` is granted (by listing it in a toolbox), it may
 * reach private / local hosts — to block that, simply don't grant the tool.
 *
 * The only hard, non-negotiable blocks remaining are loopback / unspecified
 * addresses, the link-local cloud-metadata endpoint, non-HTTP(S) schemes, and
 * invalid URLs. These protect the host process itself and are never toggleable.
 */
function checkUrlSafety(urlStr: string): UrlSafety {
  let url: URL
  try {
    url = new URL(urlStr)
  } catch {
    return { allowed: false, reason: 'Invalid URL' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: 'Only HTTP and HTTPS URLs are supported' }
  }

  const host = url.hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host === '0.0.0.0'
  ) {
    return { allowed: false, reason: 'Requests to loopback or unspecified addresses are not allowed' }
  }

  if (host === '169.254.169.254') {
    return { allowed: false, reason: 'Requests to link-local metadata endpoints are not allowed' }
  }

  return { allowed: true }
}

/**
 * http_request - Make HTTP requests to external APIs.
 * Available to main Agents and sub-Agents. Granting the tool (via a toolbox) is the
 * only gate — there is no per-Agent network flag; private/local hosts are
 * reachable when the tool is granted (loopback + cloud-metadata stay blocked).
 */
export const httpRequestTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  create: (_ctx: ToolExecutionContext) => {
    return tool({
      description:
        'Make an HTTP request to a URL. May reach private/internal and local-network hosts; only loopback and cloud-metadata endpoints are blocked.',
      inputSchema: z.object({
        method: z
          .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        url: z.string().url(),
        headers: z
          .object({})
          .catchall(z.string())
          .optional()
          .describe('HTTP headers as key-value pairs (e.g. {"Authorization": "Bearer token"})'),
        body: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .optional()
          .describe('Objects auto-serialized to JSON'),
        timeout_seconds: z
          .number()
          .optional()
          .default(30)
          .describe('Default: 30, max: 120'),
      }),
      execute: async ({ method, url, headers, body, timeout_seconds }) => {
        // SSRF guard — loopback / metadata / non-HTTP(S) are always blocked.
        const urlSafety = checkUrlSafety(url)
        if (!urlSafety.allowed) {
          return { error: urlSafety.reason }
        }

        const timeout = Math.min((timeout_seconds ?? 30) * 1000, 120_000)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeout)

        try {
          const fetchHeaders: Record<string, string> = { ...headers }

          let fetchBody: string | undefined
          if (body !== undefined) {
            if (typeof body === 'object') {
              fetchBody = JSON.stringify(body)
              if (!fetchHeaders['Content-Type'] && !fetchHeaders['content-type']) {
                fetchHeaders['Content-Type'] = 'application/json'
              }
            } else {
              fetchBody = body
            }
          }

          log.debug({ method, url }, 'HTTP request')

          const response = await fetch(url, {
            method,
            headers: fetchHeaders,
            body: fetchBody,
            signal: controller.signal,
            redirect: 'follow',
          })

          // Read response body with size limit
          const contentType = response.headers.get('content-type') ?? ''
          let responseBody: string

          const buffer = await response.arrayBuffer()
          const bytes = new Uint8Array(buffer)

          if (bytes.length > MAX_RESPONSE_BODY) {
            responseBody = new TextDecoder().decode(bytes.slice(0, MAX_RESPONSE_BODY))
            responseBody += `\n\n[...truncated, response was ${bytes.length} bytes]`
          } else {
            responseBody = new TextDecoder().decode(bytes)
          }

          // Try to parse JSON for cleaner output
          let parsedBody: unknown = responseBody
          if (contentType.includes('application/json')) {
            try {
              parsedBody = JSON.parse(responseBody)
            } catch {
              // Keep as string
            }
          }

          // Extract relevant response headers
          const responseHeaders: Record<string, string> = {}
          for (const key of ['content-type', 'content-length', 'x-ratelimit-remaining', 'x-ratelimit-limit', 'retry-after', 'location']) {
            const val = response.headers.get(key)
            if (val) responseHeaders[key] = val
          }

          return {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            body: parsedBody,
          }
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            return { error: `Request timed out after ${timeout / 1000}s` }
          }
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        } finally {
          clearTimeout(timer)
        }
      },
    })
  },
}
