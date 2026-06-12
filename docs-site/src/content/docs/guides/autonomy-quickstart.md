---
title: Autonomy Quickstart
description: Get an Agent running autonomously in 15–30 minutes — crons, webhooks, and sub-tasks explained.
---

Hivekeep Agents aren't just chatbots — they can work autonomously on schedules, react to external events, and delegate work to sub-agents. This guide takes you from zero to a working autonomous Agent.

## What "autonomy" means in Hivekeep

Three mechanisms make Agents autonomous:

| Mechanism | What it does | Example |
|---|---|---|
| **Cron jobs** | Run a task on a schedule | "Every morning at 8 AM, check my GitHub issues" |
| **Webhooks** | React to external events in real-time | "When a new issue is opened, triage it" |
| **Sub-tasks** | Delegate work to focused sub-agents | "Spawn a sub-Agent to research this topic" |

These can be combined. A cron job can spawn sub-tasks. A webhook can trigger a chain of sub-agents. The Agent orchestrates everything.

## Prerequisites

Before starting, make sure you have:

- A working Hivekeep installation ([Installation guide](/docs/getting-started/installation/))
- At least one **LLM provider** configured (Anthropic recommended — see [Model Selection](/docs/guides/model-selection/))
- At least one **embedding provider** configured (for memory)
- An Agent created ([Your First Agent](/docs/getting-started/first-agent/))

:::caution[Model choice matters]
Autonomous Agents **must** use a model with strong tool-calling capabilities. Claude Sonnet 4 or Claude Sonnet 3.5 are strongly recommended. Models that default to "text mode" (describing actions instead of executing them) will fail silently. See [Model Selection](/docs/guides/model-selection/) for details.
:::

## Step 1: Create an autonomy-ready Agent

Create a new Agent (or update an existing one) with a system prompt designed for autonomous work. The key is being **explicit about actions**:

### Character field

```
You are a disciplined automation agent. You execute tasks precisely and report results clearly.
When given a task, you ACT — you never describe what you would do, you DO it.
You always use tools to accomplish tasks. You never simulate or roleplay tool usage.
```

### Expertise field

```
You are an expert at task automation, data processing, and systematic workflows.
You know how to use all Hivekeep tools: web search, file operations, memory, HTTP requests.
When a task is complete, you summarize what was done and what the results were.
```

:::tip
The "you ACT, you never describe" pattern is critical for autonomous Agents. Without it, some models will write essays about what they _would_ do instead of actually calling tools.
:::

## Step 2: Set up your first cron job

Cron jobs are the simplest path to autonomy. Let's create one that runs daily.

### Option A: Ask the Agent to create it

Simply tell your Agent:

> Create a cron job that runs every day at 8:00 AM UTC. The task should: search the web for the latest news about "artificial intelligence", summarize the top 3 stories, and save the summary to memory.

The Agent will call `create_cron` with the appropriate configuration. You'll see a **pending approval** notification — cron jobs created by Agents always require human approval before they run.

### Option B: Understand the cron structure

When an Agent creates a cron, it specifies:

| Parameter | Description | Example |
|---|---|---|
| `title` | Short name for the job | `"Daily AI News Digest"` |
| `schedule` | Cron expression (standard 5-field) | `"0 8 * * *"` (8 AM daily) |
| `task_description` | Full prompt for the sub-Agent that runs | The detailed instructions |

Common cron schedules:

```
0 8 * * *      → Every day at 8:00 AM
0 */6 * * *    → Every 6 hours
*/30 * * * *   → Every 30 minutes
0 9 * * 1-5    → Weekdays at 9:00 AM
0 0 1 * *      → First day of each month
```

### What happens when a cron fires

1. Hivekeep spawns a **sub-Agent** (a temporary copy of your Agent)
2. The sub-Agent receives the `task_description` as its mission
3. The sub-Agent executes using all available tools
4. Results are saved — the sub-Agent **must** call `update_task_status("completed", result)` when done
5. The result appears in your Agent's conversation as an informational message
6. On the next run, the sub-Agent receives the **previous run's result** for continuity

:::note
Cron results are informational — they don't trigger an LLM turn on the parent Agent. This means your Agent won't "react" to cron results automatically. If you need the Agent to process results, design the cron task to be self-contained.
:::

## Step 3: Verify it's working

### Check the cron is registered

Ask your Agent:

> List all my cron jobs and their status.

The Agent will call `list_crons` and show you the registered jobs, including their schedule, status (active/pending), and last run time.

### Check execution history

After the first run:

> Show me the execution history for my daily news cron.

The Agent will call `get_cron_journal` to show past executions with timestamps, status (success/failure), and results.

### Manual trigger for testing

Don't wait for the schedule — trigger it now:

> Trigger my daily news cron immediately.

This runs the cron right now without affecting the regular schedule.

### What to look for in the UI

- **Task indicators**: When a cron fires, you'll see a sub-task appear in the Agent's conversation
- **Tool call markers**: Successful autonomous execution shows tool calls (web search, memory writes, etc.) — not just text responses
- **Status**: The task should end with `completed` status and a result summary

:::caution
If you see the sub-task producing only text (no tool calls), your model is running in "text mode." Switch to Claude Sonnet or see [Model Selection](/docs/guides/model-selection/) for fixes.
:::

## Step 4: Add webhook reactions (optional)

Webhooks let your Agent react to external events in real-time. Each webhook gets a unique URL you can point external services at.

### Creating a webhook

Ask your Agent:

> Create a webhook called "GitHub Events" that listens for GitHub webhook payloads. Filter to only accept payloads where the "action" field is "opened" or "labeled". Use task dispatch mode so each event spawns a sub-task.

The Agent will create a webhook with:
- **Payload filtering** — drops irrelevant events before they cost LLM tokens
- **Task dispatch mode** — each matching payload spawns an isolated sub-task

### Webhook dispatch modes

| Mode | Behavior | Best for |
|---|---|---|
| `conversation` | Payload injected into the Agent's main chat | Low-volume events you want to discuss |
| `task` | Each payload spawns an autonomous sub-task | High-volume events that need processing |

Task mode supports **concurrency control** — you can limit how many webhook-spawned tasks run in parallel to avoid overwhelming your LLM provider.

### Connecting to external services

After creating the webhook, the Agent returns a URL like:

```
https://your-hivekeep-instance/api/webhooks/incoming/<token>
```

Point your external service (GitHub, GitLab, Linear, etc.) to this URL. Hivekeep accepts any JSON payload via POST.

## Step 5: Design self-contained tasks

The secret to reliable autonomy is **self-contained task descriptions**. The sub-Agent that executes a cron or webhook task has no memory of previous conversations — it only knows what's in the task description.

### Good task description

```
You are processing a GitHub issue webhook payload.

Your mission:
1. Parse the payload to extract the issue title, body, labels, and author
2. Search the web for any relevant context about the topic
3. Write a triage comment on the issue using the GitHub MCP tools
4. Memorize a summary of your analysis for future reference
5. Call update_task_status("completed", "Triaged issue #<number>: <title>")

The payload:
{{__payload__}}
```

### Bad task description

```
Handle this GitHub issue.
```

:::tip[Task description checklist]
A good task description includes:
- ✅ Clear context (what triggered this task)
- ✅ Numbered steps with specific tool expectations
- ✅ What "done" looks like (expected `update_task_status` call)
- ✅ Any data the sub-Agent needs (payload, URLs, IDs)
- ❌ No vague instructions ("handle", "deal with", "process as needed")
:::

## Common pitfalls

### 1. Wrong model

**Symptom**: Cron tasks produce text responses instead of tool calls.
**Fix**: Use Claude Sonnet 4 or Claude Sonnet 3.5. See [Model Selection](/docs/guides/model-selection/).

### 2. Missing `update_task_status`

**Symptom**: Tasks stay "in progress" forever.
**Fix**: Always include an explicit instruction to call `update_task_status("completed", result)` in your task description.

### 3. Vague task descriptions

**Symptom**: Sub-Agents do random or incomplete work.
**Fix**: Be specific. List exact steps. Include the data they need.

### 4. No payload filtering on webhooks

**Symptom**: Your Agent processes every webhook event, burning through LLM tokens.
**Fix**: Use `filter_mode: "simple"` with `filter_field` and `filter_allowed_values` to only process relevant events.

### 5. Cron stuck in "pending approval"

**Symptom**: The cron was created but never runs.
**Fix**: Agent-created crons require admin approval. Check the pending approvals in the UI and approve it.

## Next steps

- **[GitHub Issue Processor](/docs/guides/blueprints/github-issue-processor/)** — A complete, production-tested blueprint
- **[Daily Digest](/docs/guides/blueprints/daily-digest/)** — Automated tech watch and reporting
- **[Model Selection](/docs/guides/model-selection/)** — Deep dive into model choice and troubleshooting
