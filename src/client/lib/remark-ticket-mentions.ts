/**
 * Remark plugin: scan text nodes for ticket mention tokens (`#42`, `hivekeep#42`)
 * and replace them with a synthetic mdast node that surfaces as an HTML
 * `<ticket-mention>` element. The corresponding React component is registered
 * in MarkdownContent's `components` map.
 *
 * Implementation notes:
 *
 * - We use `mdast-util-find-and-replace` so we benefit from its proper handling
 *   of node splitting (a paragraph containing "see #42 and #43" becomes three
 *   children: text, mention, text, mention).
 * - Mentions inside code (`<inline>` or fenced blocks) are skipped by default
 *   thanks to `ignore` defaults.
 * - The synthetic node uses `data.hName` so rehype renders it as a custom HTML
 *   tag — we register a `ticket-mention` component override in the renderer.
 */
import { findAndReplace } from 'mdast-util-find-and-replace'
import { TICKET_MENTION_REGEX } from '@/shared/constants'
import type { Root } from 'mdast'

interface MentionData {
  hName: 'ticket-mention'
  hProperties: { 'data-raw': string }
}

/**
 * Build the synthetic mdast node for a captured token. We anchor the regex
 * here too to avoid surprises if the global pattern lacks `g` semantics for
 * find-and-replace (which feeds it a fresh exec context).
 */
function buildReplace() {
  // Use a fresh regex instance so mdast-util-find-and-replace can manage
  // lastIndex without colliding with other consumers of the shared constant.
  const re = new RegExp(TICKET_MENTION_REGEX.source, TICKET_MENTION_REGEX.flags)

  return [
    [
      re,
      (raw: string) => {
        // The matched substring is what the author wrote, e.g. "#42" or
        // "hivekeep#42". We pass it verbatim to the component which uses it
        // both as the cache key AND the display label.
        const node = {
          type: 'text' as const,
          value: '',
          data: {
            hName: 'ticket-mention',
            hProperties: { 'data-raw': raw },
          } satisfies MentionData,
        }
        return node
      },
    ] as const,
  ]
}

/** Remark plugin factory. */
export function remarkTicketMentions() {
  return (tree: Root) => {
    // biome-ignore lint/suspicious/noExplicitAny: mdast-util-find-and-replace's typing is loose
    findAndReplace(tree, buildReplace() as any)
  }
}
