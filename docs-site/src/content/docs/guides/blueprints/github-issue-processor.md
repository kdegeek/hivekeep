---
title: "Blueprint: GitHub Issue Processor"
description: A complete, copy-paste-ready blueprint for an Agent that triages, diagnoses, and processes GitHub issues autonomously.
---

This blueprint sets up an Agent that autonomously processes GitHub issues — triaging new issues, diagnosing bugs, implementing fixes, and managing the issue lifecycle. This pattern is **running in production** on the Hivekeep repository itself.

## Use case

You have a GitHub repository and want to:
- Automatically triage incoming issues (apply labels, assign priority)
- Diagnose bug reports by reading the codebase
- Implement fixes and push them directly
- Comment on issues with analysis and status updates

## What you'll need

| Requirement | Details |
|---|---|
| **LLM Provider** | Anthropic (Claude Sonnet 4 or Sonnet 3.5) — strong tool use required |
| **Embedding Provider** | Any (OpenAI, Voyage, etc.) — for memory |
| **MCP Server** | GitHub MCP server connected to your repo |
| **Workspace** | A workspace directory with the repo cloned |

### MCP server setup

The Agent needs access to GitHub via an MCP server. In **Settings > MCP Servers**, add:

```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "<your-github-pat>"
  }
}
```

Then assign this MCP server to your Agent via its tool config (`mcpAccess`).

:::tip
Your GitHub PAT needs `repo` scope for full read/write access. For read-only triage, `public_repo` is sufficient.
:::

### Workspace setup

Your Agent needs a workspace with the repository cloned:

1. Set a **workspace directory** in the Agent settings (e.g. `/home/user/.local/share/hivekeep/workspaces/<agent-id>`)
2. Tell the Agent to clone the repo:

> Clone https://github.com/your-org/your-repo.git into your workspace directory.

The Agent will use `run_shell` to run `git clone`.

## System prompt

### Character

```
You are a precise, methodical software engineer. You diagnose issues systematically —
reading code, understanding context, and implementing targeted fixes.

You never guess. When analyzing an issue, you read the relevant source files first.
When implementing a fix, you verify it compiles/passes before pushing.

You communicate concisely: state what you found, what you did, and what the result was.
You ACT — you never describe what you would do, you DO it using tools.
```

### Expertise

```
You are an expert software developer familiar with the codebase in your workspace.
You know TypeScript, React, Node.js, and modern web development practices.

Your workflow for processing issues:
1. Read the issue details (title, body, labels, comments)
2. Search the codebase for relevant files using grep and read_file
3. Diagnose the root cause
4. Implement the fix using edit_file or multi_edit
5. Run typecheck and tests to verify
6. Commit and push to the appropriate branch
7. Comment on the issue with your findings
8. Close the issue if the fix is confirmed

When you can't fix something, you comment with a detailed analysis of what you found
and what the likely cause is, then leave the issue open.
```

## Cron configuration: scheduled issue sweep

For batch processing (e.g., sweep open issues every few hours):

Ask your Agent:

> Create a cron job called "GitHub Issue Sweep" that runs every 6 hours (schedule: "0 */6 * * *"). The task should: list all open issues in my-org/my-repo, identify any that haven't been triaged yet (no labels), and process each one — read the issue, analyze it, apply appropriate labels, and comment with an initial assessment.

### Task description template

Here's the full task description for the cron's sub-Agent:

```
You are an autonomous GitHub issue processor for the repository my-org/my-repo.

## Mission

Process all open, untriaged issues in the repository.

## Steps

1. Use mcp_github list_issues to get all open issues for my-org/my-repo
2. Filter to issues that have no labels (untriaged)
3. For each untriaged issue (max 5 per run to stay within limits):
   a. Read the issue body and any comments
   b. Search the codebase in your workspace using grep and read_file to understand the context
   c. Determine if this is a bug, feature request, question, or documentation issue
   d. Apply the appropriate labels using mcp_github update_issue
   e. If it's a bug you can diagnose, comment with your analysis
   f. If it's a simple fix, implement it:
      - Create a branch: git checkout -b fix/issue-<number>
      - Make the changes using edit_file or multi_edit
      - Run the typecheck: cd my-repo && bun run typecheck
      - If it passes, commit and push
      - Comment on the issue with what you did
4. After processing all issues, summarize what you did

## Important

- Always call update_task_status("completed", summary) when done
- If you encounter errors, call update_task_status("failed", error_description)
- Work in the workspace directory: /path/to/workspace/my-repo
- Pull latest before making changes: git checkout main && git pull
- Never force push. Never push to main without tests passing.
```

## Webhook configuration: real-time processing

For instant processing when issues are created or updated:

Ask your Agent:

> Create a webhook called "GitHub Issue Events" with task dispatch mode. Filter to only accept payloads where "action" is "opened" or "labeled". Set max concurrent tasks to 2. Use this task title template: "GitHub: {{action}} issue #{{issue.number}}" and this task prompt template:

### Task prompt template for the webhook

```
You are processing a GitHub issue event for repository my-org/my-repo.

## Event details
- Action: {{action}}
- Issue #{{issue.number}}: {{issue.title}}

## Full payload
{{__payload__}}

## Your mission

1. Parse the issue details from the payload above
2. If this is a new issue (action=opened):
   a. Read the issue body carefully
   b. Search the codebase for relevant files using grep
   c. Classify the issue (bug/feature/question/docs)
   d. Apply labels using mcp_github update_issue
   e. Comment with your initial assessment
3. If this is a labeled issue (action=labeled):
   a. Check if the label is "bug" and if so, attempt a diagnosis
   b. Search the codebase for the relevant code
   c. Comment with your findings
4. Call update_task_status("completed", "Processed issue #{{issue.number}}: <summary>")

## Workspace
Your codebase is at: /path/to/workspace/my-repo

## Rules
- Be thorough but concise in your comments
- If you can't determine the issue type, label it as "needs-triage"
- Never close issues automatically — only comment
- Always call update_task_status when done
```

### Connecting GitHub to the webhook

1. In your GitHub repo, go to **Settings > Webhooks > Add webhook**
2. Set the **Payload URL** to the webhook URL returned by Hivekeep
3. Set **Content type** to `application/json`
4. Select **Let me select individual events** and check **Issues**
5. Click **Add webhook**

## Expected outputs

When working correctly, you'll see:

- **New issues** get labels within minutes of being created
- **Bug reports** get a comment with the Agent's analysis of the likely cause
- **Simple fixes** get committed to a branch with a reference to the issue
- **Complex issues** get a detailed comment explaining what the Agent found in the codebase

### Example Agent comment on a bug report

```markdown
## Analysis

I found the issue in `src/server/services/agent-engine.ts` (line 142).
The `processMessage` function doesn't handle the case where `provider` is null,
which happens when the configured provider is deleted while a message is in the queue.

**Root cause**: Missing null check on the provider lookup.
**Suggested fix**: Add an early return with an error message when the provider is not found.

I've implemented a fix in branch `fix/issue-42` — see commit abc1234.
```

## Troubleshooting

### Agent doesn't call GitHub MCP tools

- Verify the MCP server is connected: check **Settings > MCP Servers** for a green status
- Verify the Agent's tool config has `mcpAccess` set for the GitHub server
- Check that the GitHub PAT hasn't expired

### Cron tasks fail with "no tools available"

- Sub-Agents inherit the parent's tool access. If the parent can't use MCP tools, neither can the sub-Agent
- Ensure the Agent has `run_shell`, `read_file`, `edit_file`, and `grep` available (they shouldn't be in `disabledNativeTools`)

### Webhook receives events but nothing happens

- Check the webhook's filter configuration — is the `action` field in the allowlist?
- Check the webhook stats via `list_webhooks` (it shows received/filtered/processed counts)
- Verify the task prompt template uses correct `{{placeholder}}` syntax

### Agent writes text instead of calling tools

This is the "text mode" problem. See [Model Selection](/docs/guides/model-selection/) — the fix is usually switching to Claude Sonnet.

### Tasks stay "in progress" forever

The sub-Agent isn't calling `update_task_status`. Make sure your task description explicitly instructs it to call `update_task_status("completed", result)` or `update_task_status("failed", error)`.
