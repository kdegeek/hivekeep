# Dev notes

Internal developer notes about Hivekeep internals. These are not user-facing
docs (the user-facing documentation lives on the docs site under
`docs-site/src/content/docs/`). They exist to capture schema details, resolver
semantics, and design decisions for contributors working in `src/server/`.

| Note | Covers | Source of truth in code |
|---|---|---|
| `projects-schema.md` | Projects/tickets schema, ticket-ref resolver, attachments | `src/server/services/tickets.ts`, `src/server/utils/ticket-ref.ts` |

The transferable-channel design note lives at `docs/channel-transfers.md` (kept
at that path because `src/server/channels/{telegram,matrix,discord}.ts` reference
it by that exact path in code comments).
