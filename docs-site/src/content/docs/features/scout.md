---
title: Scout
description: "Scout is a cheap, fast model role an Agent delegates heavy read-only exploration to, instead of grinding through it on its expensive main model."
---

Scout is a lightweight model role for grunt work. When an Agent needs to do a lot of read-only exploration (searching a codebase, mapping out files, gathering web context), running every step on its expensive main model is slow and wasteful. Scout lets the Agent hand that exploration to a small, fast, cheap model and wait for a digest, the same way a developer using a coding assistant offloads heavy file-reading to a cheaper sub-agent instead of burning premium steps on it.

## What scout actually is

There are two related things called "scout": a **tool** an Agent calls, and a **model role** that tool runs on.

### The `scout` tool

`scout` is a native tool available to both main Agents and sub-Agents. When an Agent calls it with a self-contained brief, the tool:

1. Resolves a cheap "scout" model (see the resolution chain below).
2. Spawns an `await` sub-task on that model, using the read-only **`scout` toolbox** (`grep`, `read_file`, `list_directory`, `web_search`, `browse_url`, `extract_links`). The scout toolbox has no write tools and no spawn or scout tools, so a scout is always a leaf: it explores, it cannot mutate anything, and it cannot delegate further.
3. **Blocks** the calling Agent until the scout returns its digest, which becomes the tool's result and arrives as the Agent's next message.

The scout sub-task has no view of the calling conversation, so the brief must be self-contained: what to find or read, which paths or queries to start from, and the shape of digest to report back. The tool accepts optional `hints` (focus paths and suggested searches) that are folded into the brief.

This is the only confirmed use of scout in the codebase: delegated, read-only exploration via the `scout` tool. It is not used for compacting, memory extraction, or message titling; those are separate model roles (see below).

### Where the scout tool is available

The `scout` tool is included in the built-in `code`, `research`, and `ops` toolboxes, so any Agent with one of those (or the `all` toolbox, or a custom toolbox that lists `scout`) can delegate exploration. See [Toolboxes](/hivekeep/docs/features/toolboxes/) for how grants work.

## How the scout model is resolved

The scout model is resolved through a fallback chain, most specific first. The first tier that has a non-empty model wins:

1. **Per-call override**: an explicit `model` (plus its `provider_id`) passed to the `scout` tool for that call only.
2. **Agent scout**: the Agent's own `scoutModel` / `scoutProviderId`.
3. **Project scout**: when the scout runs in a project context, the project's `scoutModel` / `scoutProviderId`.
4. **Global scout default**: the platform-wide default (`default_scout_model` / `default_scout_provider_id`).
5. **The Agent's own main model**: the safety net.

Because the chain ends at the Agent's own model, scout is **purely additive**: on an install with no scout configuration at all, every scout simply runs on the calling Agent's main model. Nothing breaks; you just do not get the cost savings until you point scout at a cheaper model.

:::note
When you override the scout model on a single `scout` call, you must pass `provider_id` too. The same model name can be served by more than one provider, and Hivekeep will not guess which one you mean.
:::

## Configuring scout

Scout is configured through the UI, at three levels matching the resolution chain. (There is no environment variable for the scout default; it is stored as a platform setting.)

- **Global default**: in **Settings → Models & services**, set the **Default Scout Model**. A small, fast model is ideal here. When unset, scouts fall back to the calling Agent's own model.
- **Per Agent**: in an Agent's settings, set its **Scout model**. Leave it on inherit to fall back to the project scout default, then the global default, then the Agent's own model.
- **Per project**: in a project's settings, set its **Default scout model** to override the global default for tasks on that project's tickets.

These can also be set programmatically. The global default is one of the model-bearing services handled by the `set_default_model` tool, alongside `llm`, `embedding`, `image`, `compacting`, and `extraction`:

```text
set_default_model(service: "scout", model: "claude-haiku-4-6", provider_id: "anthropic")
```

[Queenie](/hivekeep/docs/features/queenie/) can do this for you in conversation, and `get_default_models` reports the current scout default along with the rest.

## When to use scout

Reach for scout when an Agent would otherwise spend many of its own steps reading and grepping before it can act. A good brief asks the scout to gather and summarize, then hands the digest back so the main Agent can reason on a compact result rather than dozens of raw file reads. Because the scout runs read-only and cannot write or spawn, it is safe to delegate freely.

## Related pages

- [Toolboxes](/hivekeep/docs/features/toolboxes/): the `scout` toolbox the scout runs with, and the toolboxes that grant the `scout` tool.
- [Choosing a Model](/hivekeep/docs/guides/model-selection/): picking models for each role.
- [Queenie, guided setup](/hivekeep/docs/features/queenie/): can set your default scout model in conversation.
