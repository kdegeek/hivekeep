# claude-code

Spawn autonomous Claude Code coding sessions from a Kin and watch progress
live in the conversation. This plugin wraps the official
[@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk),
which drives the `claude` CLI binary in a working directory of your
choosing.

## What you can do with it

- Hand off non-trivial coding tasks (multi-file refactors, feature work,
  exploratory debugging) to Claude Code while keeping the Kin's main
  conversation focused on planning and review.
- See progress live: phase, current step, tool calls, log preview, and
  final result land inline as a single sticky card.
- Abort a runaway session in one click, or send a follow-up message
  after completion to continue with the same Claude Code session id.

## Prerequisites

1. **`claude` CLI installed system-wide.** The SDK shells out to the
   official binary:
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```
2. **One of two auth methods**:
   - **Subscription** (default, recommended for Claude Max users): run
     `claude login` once on the host to drop OAuth credentials into
     `~/.claude/.credentials.json`. The SDK picks them up automatically.
   - **API key**: any Anthropic API key with permission to invoke the
     Claude model. Billed pay-per-token.

## Setup

1. Install the plugin via the Plugins page in Settings (or place this
   folder under `plugins/` and reload).
2. Configure it:
   - **Authentication mode**: `subscription` or `apiKey`.
   - **Anthropic API key**: required when `authMode` is `apiKey`.
   - **Default working directory**: absolute path under which sessions
     run when the caller does not specify one. Leave empty to require
     `workingDir` on every call.
   - **Default max turns**: hard cap on agentic turns per session. The
     default of 50 is a reasonable upper bound for most tasks.
   - **Permission mode**: `bypassPermissions` (full autonomy, default),
     `acceptEdits` (auto-accept file edits only), or `plan` (produce a
     plan without executing).
3. Opt the tool into each Kin that should use it. The `claude_code_run`
   tool is `defaultDisabled: true` and only appears for Kins whose
   `toolConfig` lists it, the same way MCP and other autonomy-heavy
   tools are gated.

## Usage from a Kin

The Kin calls `claude_code_run` like any other tool. Inputs:

| Field | Type | Default | Notes |
|---|---|---|---|
| `prompt` | string | required | Task description. Be specific about scope, files, and expected outcomes. |
| `workingDir` | string | plugin default | Absolute path to run in. |
| `maxTurns` | number | plugin default | Per-call cap override. |
| `resumeSessionId` | string | none | Continue a previous Claude Code session. |
| `wait` | boolean | `false` | If true, the tool awaits completion and returns the final message. If false (default), the tool returns immediately and the Kin watches the live card. |

In **fire-and-forget** mode (default) the tool returns a `cardInstanceId`
and a one-line confirmation; the Kin can resume reasoning while the
card updates in the background.

In **wait** mode the tool awaits completion and returns:

```json
{
  "ok": true,
  "cardInstanceId": "...",
  "sessionId": "...",
  "finalMessage": "Summary returned by Claude Code",
  "numTurns": 12,
  "durationMs": 41230,
  "totalCostUsd": 0.27,
  "error": null
}
```

## What the card looks like

- **Header** with a `Sparkles` icon and an accent that turns green on
  success or red on error/abort.
- **Status row**: current phase, working directory, short session id
  once available.
- **Progress bar** with the current step labeled underneath (e.g.
  `Edit: src/foo.ts`, `Bash: bun test`).
- **Collapsible log stream** that buffers up to 200 recent lines.
- **Action row**:
  - During the run: `Abort` (confirmation required).
  - After completion: `Send follow-up`, with a textarea for the next
    instruction. Submitting starts a new run with `--resume` pointing
    at the previous session id, so the same card keeps streaming.

## Programmatic control

In addition to `claude_code_run`, the plugin exposes four tools that let
a Kin inspect, drive, and stop sessions without depending on the card
buttons. All four are tagged `availability: ['main', 'sub-kin']` and
share the same `defaultDisabled` opt-in as `claude_code_run`.

| Tool | Purpose | Concurrency |
|---|---|---|
| `claude_code_run` | Spawn a new session. Returns a `cardInstanceId`. | mutating |
| `claude_code_list_sessions` | List running and recently completed sessions, optionally filtered by status. | read-only, parallel-safe |
| `claude_code_get_session` | Fetch the full state of one session (phase, current step, tail of logs, final message, error). | read-only, parallel-safe |
| `claude_code_send_message` | Continue a completed session with a follow-up prompt (same card, resumed sessionId). | mutating |
| `claude_code_abort` | Stop a running session, optionally with a reason recorded in the logs. | mutating |

### Example usage from a Kin

Fire-and-forget a session, do other work, poll for progress, abort if
the run goes off the rails:

```ts
// 1. Start the session in the background.
const start = await claude_code_run({
  prompt: 'Refactor src/server/services/tasks.ts to extract task message previews into a helper.',
  wait: false,
})
const cardInstanceId = start.cardInstanceId

// 2. Continue reasoning, then check in periodically.
const snapshot = await claude_code_get_session({ cardInstanceId, logTail: 5 })
if (snapshot.status === 'running' && snapshot.currentStep?.includes('infinite loop')) {
  await claude_code_abort({ cardInstanceId, reason: 'detected runaway tool loop' })
}

// 3. After the session has completed, continue the conversation.
if (snapshot.status === 'completed') {
  await claude_code_send_message({
    cardInstanceId,
    message: 'Also update the unit tests for the new helper.',
    wait: true,
  })
}
```

`claude_code_list_sessions` is useful for discovering active work after
a reload of the Kin's context, or for monitoring across multiple
concurrent runs:

```ts
const { sessions } = await claude_code_list_sessions({ status: 'running', limit: 10 })
for (const s of sessions) {
  console.log(s.cardInstanceId, s.currentStep, s.numTurns)
}
```

### V1 limitations of the control surface

- `recentRuns` is kept in process memory, bounded to 50 entries with
  FIFO eviction. Sessions completed before the last restart, or older
  than the most recent 50, are not visible to `list_sessions` or
  `get_session`.
- There is no DB-persisted session history yet, so `cardInstanceId` is
  only meaningful within a single process lifetime.
- `claude_code_send_message` refuses while the target session is still
  running. Call `claude_code_abort` first or wait for the run to land
  (poll `claude_code_get_session` for `status: 'completed'`).
- Abort is best-effort: it triggers the SDK `AbortController`, but the
  card only flips to `aborted` once the runner unwinds. Poll
  `get_session` if you need to confirm completion.

## Troubleshooting

- **`No working directory configured`**: either configure
  `defaultWorkingDir` on the plugin, or pass `workingDir` on every
  `claude_code_run` call.
- **`authMode is apiKey but no apiKey is configured`**: set the
  Anthropic API key in the plugin config, or switch `authMode` to
  `subscription` after running `claude login`.
- **Session errors / max turns reached**: the card shows the SDK's
  `stop_reason` in the status row and the last log lines. Use
  `Send follow-up` with a corrective prompt to retry.
- **`command not found: claude` in logs**: install the official CLI
  (`npm install -g @anthropic-ai/claude-code`) and ensure the host
  PATH includes the global npm bin.

## Security notes

`bypassPermissions` is the default permission mode because the whole
point of the integration is to delegate autonomously. That mode lets
Claude Code edit files, run shell commands, and reach the network with
no per-action confirmation, so:

- Only configure working directories you are comfortable Claude Code
  fully owning during a session.
- Do not point `defaultWorkingDir` at directories that contain
  unrelated repositories, system configuration, or anything you would
  not give a junior contractor write access to.
- Prefer `acceptEdits` (only file edits auto-approved) or `plan` mode
  for environments where you want a tighter blast radius.

## Limitations (V1)

- No standalone `Resume` button; reuse `Send follow-up` with the
  desired prompt to continue an existing session.
- Cards are not yet surfaced in the Tasks panel; they live in the
  conversation timeline only.
- Fire-and-forget mode does not currently post an automated follow-up
  message to the Kin on completion. The Kin sees the card change to
  `Completed` on its next turn; for synchronous results use `wait=true`.
