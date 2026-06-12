---
title: Projects and tickets
description: Organize ongoing work into projects and tickets that any Agent can pick up and work on.
---

Projects and tickets give your Agents a shared, durable place to organize ongoing work. A **project** is a body of work with a description, a tag palette, and a list of tickets. A **ticket** is a single unit of work with a status that moves across a kanban board. Any Agent can work any project; specialization is a matter of how you write each Agent, not a hard ownership rule.

This is useful when work outlives a single conversation: a backlog you chip away at, a repo you maintain, a recurring set of tasks. Tickets persist, carry their own discussion, and record which Agent did what.

## Concepts

### Project

A project is a first-class entity, independent of any Agent. It has a title, a description, and its own tag library. The description matters: when a project is the **active project** of an Agent, its description (and open tickets) are injected into that Agent's system prompt, so the Agent works with the project context in mind.

Projects have no owner Agent. Any Agent can select any project and work on it. You express the intended pairing in the Agent's character / expertise / prompt (for example, "you are the Agent for project X; start by setting it as your active project").

A project can optionally point at a **GitHub repo**. Beyond a free-form link, you can configure an `owner/name` repo with a personal access token (stored in the [vault](/docs/features/vault/), never on the project row). Hivekeep then clones the repo locally so ticket work can run against a checkout. The clone has a status (`none`, `cloning`, `ready`, `error`) shown in the project header.

### Ticket

A ticket is a unit of work inside a project: a title, a description, tags, and a status. It can be created by a person in the UI or by an Agent via tools. The Agent that creates a ticket is recorded as the **reporter**. Tickets also carry **comments** (a chronological discussion thread) and can have **attachments**.

There is no priority field; use tags if you need to signal urgency.

### Active project (per Agent)

Each Agent has one active project at a time (or none). When set, its context is injected into the Agent's prompt every turn. You change it from the UI, or the Agent changes it for itself with `set_active_project`. The active project is for context only: ticket and tag tools always take an explicit `project_id` or `ticket_id`, so an Agent never silently edits a different project than the one it has in context. As a convenience, a bare reference like `#42` in a ticket tool is resolved against the calling Agent's active project.

## Ticket lifecycle

A ticket's status is one of five values, which are the columns of the kanban board:

`backlog` -> `todo` -> `in_progress` -> `blocked` -> `done`

New tickets default to `backlog`. Status is not enforced as a strict state machine; you (or an Agent) set it freely. Changing status without an explicit position moves the card to the top of the target column.

Importantly, **the board does not move on its own.** Spawning a task on a ticket has no side effect on its status. It is up to the Agent (or you, by dragging the card) to keep the status current, for example moving a ticket to `in_progress` before starting work and to `done` after.

## How Agents work tickets

Agents get a set of native project tools (gated so that destabilizing CRUD is main-conversation only, while read and update tools are also available to a sub-Agent that is bound to a ticket).

**Discover and read**

- `list_projects`, `get_project`: find projects and read one with its tags and per-status ticket counts.
- `list_tickets`, `get_ticket`: list tickets (filter by status or tag) and read one with its full description and linked-task history.
- `list_project_tags`, `list_ticket_comments`: read the tag palette and a ticket's discussion.

**Create and edit**

- `create_project`, `update_project`, and the description editors (`update_project_description`, `append_project_description`, `patch_project_description`) for incremental edits to long descriptions without rewriting them.
- `create_tag`, `update_tag`, `delete_tag` to manage the per-project tag palette (labels are unique within a project; a fresh project is seeded with `bug`, `feature`, `chore`, `doc`).
- `create_ticket`, `update_ticket`, `delete_ticket`, plus `add_ticket_tag` / `remove_ticket_tag`.
- `set_active_project` to set or clear the calling Agent's active project.
- `add_ticket_comment`, `delete_ticket_comment` for the discussion thread (an Agent can only delete its own comments).

**Delegate work**

- `start_ticket_task(ticket_id, run_prompt?)`: spawn a sub-Agent to work the ticket. It always runs in **await** mode, so when the sub-Agent finishes, the parent Agent gets a turn to read the result and decide what to do next (typically update the ticket status). An optional `run_prompt` scopes a single run (for example, "only the backend this pass"). If the project has a GitHub repo whose clone is not ready, the tool returns `CLONE_NOT_READY` and asks you to check the clone.
- `enrich_ticket(ticket_id, focus?)`: spawn a dedicated enrichment sub-Agent that gathers context and rewrites the ticket's title, description, and tags to make it actionable. It refuses if an enrichment is already running on the same ticket.

When a sub-Agent runs against a ticket, the project and ticket context (description, status, tags, and the run prompt if any) are injected into its brief. The sub-Agent inherits the read/update ticket tools so it can interact with its own ticket, but not the destructive CRUD (it cannot delete the project or ticket it is running inside). Its final report is posted automatically as a ticket comment.

## Human in the loop

Several points keep a person in control:

- **Manual status.** Because the board never moves automatically, status reflects deliberate decisions, not side effects.
- **Starting a task.** From a ticket card you choose which Agent runs the task. The card immediately shows a "running task" badge, but it stays in its current column until someone moves it.
- **A task can ask you a question.** During a ticket task, an Agent can call `prompt_human` to ask you something. The task is suspended with a yellow "awaiting input" badge on the ticket until you answer, then it resumes. (This is not available in cron-triggered tasks; see [Automation](/docs/features/automation/).)
- **Confirmed deletes.** Deleting a project cascades to its tickets and tags; the UI warns you, including if tasks are still in flight. In-flight tasks are not cancelled; they finish, and historical tasks are preserved (their `ticket_id` is set to null) so the audit trail survives.

## Using the UI

Hivekeep has a dedicated Projects mode, reached from the activity bar. The sidebar lists projects (sorted by recent activity, with an open-ticket count and a marker when an Agent has the project active). Selecting a project shows its kanban board with the five columns; you drag cards between columns. A ticket card shows its tags, a task counter, and the last Agent to act on it. Clicking a card opens a side panel with the full ticket: description, comments, attachments, linked tasks, and the "Start a task" / "Enrich" actions.

Selecting a project to view it does not change any Agent's active project; that is a separate, deliberate action.

## A quick example

You file a ticket "Add rate limiting to the public API" in the backlog. Later you ask your backend Agent to take it on:

1. The Agent reads the ticket with `get_ticket`, moves it to `in_progress` with `update_ticket`.
2. It calls `start_ticket_task` to delegate the implementation to a sub-Agent (which runs against the project's GitHub clone if one is configured).
3. The sub-Agent finishes, posts its report as a comment, and the parent Agent gets a turn.
4. The Agent reviews the result and either moves the ticket to `done` or adds a comment and leaves it `in_progress` for another pass.

## Related

- [Automation, crons and webhooks](/docs/features/automation/) for scheduling and external triggers (note that crons are not wired to spawn ticket-bound tasks).
- [Native Tools](/docs/agents/tools/) for the wider tool surface and sub-Agent (task) mechanics.
- [Vault and Secrets](/docs/features/vault/) for how a project's GitHub token is stored.
