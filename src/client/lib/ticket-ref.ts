/**
 * Format a human-readable ticket reference (GitHub-style #42).
 *
 * Single source of truth for the `#42` / `slug#42` shapes that are otherwise
 * inlined across TicketCard, EditTicketModal, the ticket/task side panels and
 * the chat mention autocomplete. Keeping the formatting here means a change to
 * the convention (e.g. zero-padding, a different separator) is a one-line edit.
 *
 * @param number  Per-project monotonic ticket number. `null`/`undefined` for
 *                legacy rows awaiting backfill — returns `null` so callers can
 *                conditionally skip rendering.
 * @param slug    Optional project slug. When provided, the ref is qualified
 *                (`hivekeep#42`); otherwise it stays bare (`#42`). An empty slug
 *                (legacy projects pre-backfill) is treated as absent.
 * @returns The formatted ref, or `null` when there is no number to show.
 */
export function formatTicketRef(
  number: number | null | undefined,
  slug?: string | null,
): string | null {
  if (number === null || number === undefined) return null
  return slug ? `${slug}#${number}` : `#${number}`
}
