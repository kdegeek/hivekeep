# Projects & tickets (internal dev note)

> Internal developer note on the projects/tickets schema and resolver internals.
> Not user-facing docs. The user-facing Projects guide lives on the docs site
> under `docs-site/src/content/docs/`. Keep this in sync with
> `src/server/services/tickets.ts` and `src/server/utils/ticket-ref.ts`.

Hivekeep ships an internal project tracker. A project is a long-lived workspace
(repo, mission, product line) holding a kanban board of tickets and a palette
of tags. Tickets are independent units of work that can be addressed by humans
in chat, by tools, and by sub-Agent tasks spawned from a card.

Schema highlights:
- `projects` — has a stable internal UUID **and** a `slug` (unique, human-typeable)
- `project_tags` — palette of `(label, color)` scoped to a project
- `tickets` — has a UUID, a per-project `number`, and links to one project
- `ticket_tags` — many-to-many between tickets and tags
- `tasks` (existing) — gain an optional `ticket_id` foreign key when spawned
  from a ticket via `start_ticket_task()`

## Identifying a ticket

A ticket has three valid identifiers; tools accept any of them.

| Format            | Example                                | When to use                          |
|-------------------|----------------------------------------|--------------------------------------|
| **UUID**          | `9ba56654-c252-4a23-afa9-d6d227f2d05b` | Programmatic, FK in DB, SSE payloads |
| **Qualified id**  | `hivekeep#42`                            | Cross-project chat, commit messages  |
| **Bare number**   | `#42` or `42`                          | Same-project chat, with an active project set |

The UUID is the source of truth and is what all foreign keys (`tasks.ticket_id`,
audit rows, etc.) store. The `number` and `slug#number` forms are *display*
forms designed to be easy to type and read.

### Project slug

- Validated against `PROJECT_SLUG_REGEX = /^[a-z][a-z0-9-]{1,31}$/`
- Lowercase, 2 to 32 chars, must start with a letter
- Auto-generated from the project title on `createProject()` — colliding slugs
  get a `-2`, `-3`, ... suffix until unique
- Editable only while the project has zero tickets (any existing ticket may
  already be referenced as `slug#N` elsewhere); update fails with `SLUG_LOCKED`
- Legacy projects created before the slug feature shipped are backfilled at
  startup (see `backfillProjectSlugs()` in `src/server/db/index.ts`)

### Ticket number

- Per-project monotonic integer starting at 1
- Allocated atomically on `createTicket()` via a SQLite transaction
  (`MAX(number) + 1` inside the same write), and guarded by a unique index
  on `(project_id, number)` so a duplicate would error rather than corrupt
- Never reused — deleting `#42` leaves the next ticket at `#43`
- Legacy tickets are backfilled at startup by `createdAt ASC` within each project

## Resolver semantics

`resolveTicketRef(raw, { activeProjectId? })` in `src/server/services/tickets.ts`
turns any of the three formats into a UUID. Failure modes are surfaced as
structured codes instead of thrown exceptions:

| Code                | Cause                                                       |
|---------------------|-------------------------------------------------------------|
| `INVALID_TICKET_REF`| Input cannot be parsed as any of the three formats          |
| `PROJECT_NOT_FOUND` | Slug does not match any project (qualified form)            |
| `TICKET_NOT_FOUND`  | Project exists but has no ticket with that number, or the UUID does not exist |
| `NO_ACTIVE_PROJECT` | Bare form used with no active project on the calling Agent    |

Pure parsing lives in `src/server/utils/ticket-ref.ts` (`parseTicketRef` +
`ticketResolutionMessage`) and is unit-tested without touching the DB.

## Tools that accept the three formats

All ticket-scoped tools resolve their `ticket_id` argument through the resolver:

- `get_ticket(ticket_id)`
- `update_ticket(ticket_id, ...)`
- `delete_ticket(ticket_id)`
- `add_ticket_tag(ticket_id, tag_id)`
- `remove_ticket_tag(ticket_id, tag_id)`
- `start_ticket_task(ticket_id)`
- `list_ticket_attachments(ticket_id)` / `read_ticket_attachment(ticket_id, attachment_id)`
- `add_ticket_attachment(ticket_id, source, name?, description?)`
- `update_ticket_attachment(ticket_id, attachment_id, { name?, description? })`
- `delete_ticket_attachment(ticket_id, attachment_id)`

`create_ticket(...)` is unchanged: it takes a `project_id` and returns the
freshly-allocated `number` on the ticket payload.

The active project (per Agent) is the one set by `set_active_project()`. When
present, bare references like `#42` resolve against it.

## UI surface

- Kanban cards display `#N` to the left of the title in a small monospaced badge
- The project header shows the `slug` next to the title
- The sidebar shows the slug as a subtitle next to the ticket counter
- The edit dialog shows `#N` next to the dialog title

## Attachments

Tickets accept arbitrary file attachments (PDF, CSV, images, archives, source
code, etc.). They are first-class on the ticket: a deletion cascades to the
files, and Agents working on the ticket can list/read/add/rename/delete them.

- **DB**: `ticket_attachments` table with a `ticket_id` FK cascading on delete
- **Disk**: files live under `${UPLOAD_DIR}/tickets/<projectId>/<ticketId>/<id>.<ext>`
- **Service**: `src/server/services/ticket-attachments.ts` handles CRUD plus
  on-disk cleanup (`purgeAttachmentsForTicket` is invoked by `deleteTicket`)
- **REST**:
  - `GET    /api/tickets/:id/attachments` — list
  - `POST   /api/tickets/:id/attachments` — multipart upload (1..N `files`)
  - `GET    /api/tickets/:id/attachments/:attachmentId` — metadata
  - `GET    /api/tickets/:id/attachments/:attachmentId/raw` — stream bytes
    (inline by default; `?download=1` forces `Content-Disposition: attachment`,
    same for executable extensions `.exe`/`.bat`/`.sh`/...)
  - `PATCH  /api/tickets/:id/attachments/:attachmentId` — rename / description
  - `DELETE /api/tickets/:id/attachments/:attachmentId`
- **SSE**: every mutation emits a `ticket:updated` event so the kanban and
  side-panel refresh `attachmentCount` in real time.
- **Size cap**: `TICKET_ATTACHMENT_MAX_SIZE` (MB), defaulting to
  `UPLOAD_MAX_FILE_SIZE` (50 MB). Empty files are rejected.
- **Agent access**: `read_ticket_attachment` decodes text-like content inline
  (capped at ~200 KB by default; `max_bytes` to raise/lower). For binaries,
  the tool returns the absolute `stored_path` so the Agent can run `read_file`
  on it directly or open it externally (e.g. PDF extraction tools).

## Prompt block injection

The system prompt's *Ticket assignment* block exposes both the slug and the
number to sub-Agents, so a sub-task working on `hivekeep#42` can refer to it in
its replies and tool calls without ever seeing the UUID. The *Active project*
block similarly lists `slug#N` for open tickets.
